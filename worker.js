// ========== 常量配置 ==========
const MUSIC_DIR = 'music/';
const LRC_DIR   = 'lrc/';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;   // 30天
const REFRESH_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7天
const MAX_FILENAME_LENGTH = 255;              // 最大文件名长度
const MAX_SEARCH_LENGTH = 200;                // 最大搜索长度
const MAX_MUSIC_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_LRC_FILE_SIZE = 1024 * 1024;        // 1MB

// 日志级别映射
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const DEFAULT_LOG_LEVEL = 'INFO';

// 内存缓存（快速访问）
let cachedPlaylist = null;
let cacheTime = 0;

// D1 表名
const CACHE_TABLE = 'cache';
const CACHE_KEY = 'playlist';

// ========== 日志模块 ==========
class Logger {
  constructor(env) {
    const configuredLevel = (env && env.LOG_LEVEL) || DEFAULT_LOG_LEVEL;
    this.level = LOG_LEVELS[configuredLevel.toUpperCase()] ?? LOG_LEVELS.INFO;
  }

  _log(level, message, context = {}) {
    if (LOG_LEVELS[level] < this.level) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    };
    const consoleMethod = level === 'ERROR' ? console.error :
                          level === 'WARN'  ? console.warn :
                          console.log;
    consoleMethod(JSON.stringify(entry));
  }

  debug(msg, ctx) { this._log('DEBUG', msg, ctx); }
  info(msg, ctx)  { this._log('INFO',  msg, ctx); }
  warn(msg, ctx)  { this._log('WARN',  msg, ctx); }
  error(msg, ctx) { this._log('ERROR', msg, ctx); }
}

let logger = null;

// ========== 工具函数 ==========
function parseFilename(filename) {
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1) {
    return { artist: '', title: filename };
  }
  const ext = filename.slice(lastDotIndex + 1).toLowerCase();
  if (ext !== 'mp3' && ext !== 'lrc') {
    return { artist: '', title: filename };
  }
  const nameWithoutExt = filename.slice(0, lastDotIndex);
  let artist = '';
  let title = nameWithoutExt;

  const dashSpaceIndex = nameWithoutExt.indexOf(' - ');
  if (dashSpaceIndex !== -1) {
    artist = nameWithoutExt.slice(0, dashSpaceIndex).trim();
    title = nameWithoutExt.slice(dashSpaceIndex + 3).trim();
  } else {
    const dashIndex = nameWithoutExt.indexOf('-');
    if (dashIndex !== -1) {
      artist = nameWithoutExt.slice(0, dashIndex).trim();
      title = nameWithoutExt.slice(dashIndex + 1).trim();
    }
  }
  return { artist, title };
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
}

function sanitizeFilename(filename) {
  return filename.replace(/[^\w\u4e00-\u9fa5\-\.\s]/g, '');
}

function escapeHeaderValue(value) {
  return value.replace(/["\\\r\n]/g, (match) => {
    switch (match) {
      case '"': return '\\"';
      case '\\': return '\\\\';
      case '\r': return '\\r';
      case '\n': return '\\n';
      default: return match;
    }
  });
}

function getClientIp(request) {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp && /^[\d\.:a-fA-F]+$/.test(cfIp)) return cfIp;
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) {
    const firstIp = xff.split(',')[0].trim();
    if (/^[\d\.:a-fA-F]+$/.test(firstIp)) return firstIp;
  }
  const xri = request.headers.get('X-Real-IP');
  if (xri && /^[\d\.:a-fA-F]+$/.test(xri)) return xri;
  return 'unknown';
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// ========== D1 数据库操作 ==========
async function initD1(env, requestId) {
  if (!env.DB) {
    logger.warn('D1 not bound, using memory-only cache', { requestId });
    return false;
  }
  try {
    // 创建表（如果不存在）
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS ${CACHE_TABLE} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
    logger.debug('D1 table ready', { requestId });
    return true;
  } catch (err) {
    logger.error('Failed to init D1 table', { requestId, error: err.message });
    return false;
  }
}

async function loadFromD1(env, requestId) {
  if (!env.DB) return null;
  try {
    const stmt = env.DB.prepare(`SELECT value, updated_at FROM ${CACHE_TABLE} WHERE key = ?`).bind(CACHE_KEY);
    const result = await stmt.first();
    if (result) {
      logger.debug('Loaded from D1', { requestId, updated_at: result.updated_at });
      return {
        playlist: JSON.parse(result.value),
        cacheTime: result.updated_at
      };
    }
  } catch (err) {
    logger.error('Failed to load from D1', { requestId, error: err.message });
  }
  return null;
}

async function saveToD1(env, playlist, cacheTime, requestId) {
  if (!env.DB) return false;
  try {
    const value = JSON.stringify(playlist);
    const stmt = env.DB.prepare(`
      INSERT OR REPLACE INTO ${CACHE_TABLE} (key, value, updated_at)
      VALUES (?, ?, ?)
    `).bind(CACHE_KEY, value, cacheTime);
    await stmt.run();
    logger.debug('Saved to D1', { requestId, count: playlist.length, cacheTime });
    return true;
  } catch (err) {
    logger.error('Failed to save to D1', { requestId, error: err.message });
    return false;
  }
}

async function deleteFromD1(env, requestId) {
  if (!env.DB) return false;
  try {
    const stmt = env.DB.prepare(`DELETE FROM ${CACHE_TABLE} WHERE key = ?`).bind(CACHE_KEY);
    await stmt.run();
    logger.debug('Deleted from D1', { requestId });
    return true;
  } catch (err) {
    logger.error('Failed to delete from D1', { requestId, error: err.message });
    return false;
  }
}

// ========== 核心：从 api.txt 获取播放列表 ==========
async function fetchPlaylistFromApiTxt(env, requestId) {
  const baseUrl = env.BASE_URL;
  if (!baseUrl) throw new Error('环境变量 BASE_URL 未设置');
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const apiTxtUrl = `${normalizedBase}api.txt`;

  const fetchStart = Date.now();
  logger.debug('Fetching api.txt', { requestId, url: apiTxtUrl });
  const response = await fetch(apiTxtUrl, {
    headers: { 'User-Agent': 'Cloudflare-Worker' }
  });
  const fetchDuration = Date.now() - fetchStart;
  if (!response.ok) {
    logger.error('Failed to fetch api.txt', { requestId, status: response.status, duration: fetchDuration });
    throw new Error(`获取 api.txt 失败: ${response.status}`);
  }

  const text = await response.text();
  const lines = text.split('\n').filter(line => line.trim() !== '');
  if (lines.length === 0) {
    logger.warn('api.txt is empty', { requestId });
    throw new Error('api.txt 为空');
  }

  const playlist = lines.map((line, index) => {
    let rawName = line.trim().replace(/^\d+/, '');
    if (!rawName.toLowerCase().endsWith('.mp3')) rawName += '.mp3';
    const info = parseFilename(rawName);
    const baseName = rawName.replace('.mp3', '');
    const musicUrl = `${normalizedBase}${MUSIC_DIR}${encodeURIComponent(rawName)}`;
    const lrcUrl = `${normalizedBase}${LRC_DIR}${encodeURIComponent(baseName + '.lrc')}`;
    return {
      id: index + 1,
      name: rawName,
      artist: info.artist,
      title: info.title,
      url: musicUrl,
      lrc: lrcUrl,
    };
  });

  logger.info('Fetched playlist', { requestId, count: playlist.length, duration: fetchDuration });
  return playlist;
}

// ========== 获取播放列表（内存 + D1 持久化缓存） ==========
async function getPlaylist(env, requestId) {
  const now = Date.now();

  // 1. 尝试从内存读取
  if (cachedPlaylist && (now - cacheTime) < CACHE_TTL) {
    logger.debug('Memory cache hit', { requestId, age: now - cacheTime });
    // 检查是否需要刷新
    if ((now - cacheTime) < REFRESH_INTERVAL) {
      return cachedPlaylist;
    }
    // 需要刷新，尝试从源更新
    logger.info('Cache refresh triggered (memory)', { requestId });
    try {
      const newPlaylist = await fetchPlaylistFromApiTxt(env, requestId);
      const changed = !(newPlaylist.length === cachedPlaylist.length &&
                        newPlaylist.every((item, i) => item.name === cachedPlaylist[i].name));
      if (changed) {
        logger.info('Cache updated (content changed)', { requestId, newCount: newPlaylist.length });
        cachedPlaylist = newPlaylist;
        cacheTime = now;
        await saveToD1(env, newPlaylist, now, requestId);
        return newPlaylist;
      } else {
        logger.info('Cache refreshed (no change)', { requestId });
        cacheTime = now;
        await saveToD1(env, cachedPlaylist, now, requestId);
        return cachedPlaylist;
      }
    } catch (error) {
      logger.error('Refresh failed, using old cache', { requestId, error: error.message });
      return cachedPlaylist;
    }
  }

  // 2. 内存未命中或已过期，尝试从 D1 加载
  logger.debug('Memory cache miss or expired', { requestId, cacheExists: !!cachedPlaylist, cacheAge: cacheTime ? now - cacheTime : null });
  const d1Data = await loadFromD1(env, requestId);
  if (d1Data && (now - d1Data.cacheTime) < CACHE_TTL) {
    logger.info('Loaded from D1, updating memory', { requestId, age: now - d1Data.cacheTime });
    cachedPlaylist = d1Data.playlist;
    cacheTime = d1Data.cacheTime;
    // 检查是否需要刷新（基于 D1 的时间）
    if ((now - cacheTime) < REFRESH_INTERVAL) {
      return cachedPlaylist;
    }
    // 需要刷新，尝试从源更新
    logger.info('Cache refresh triggered (D1)', { requestId });
    try {
      const newPlaylist = await fetchPlaylistFromApiTxt(env, requestId);
      const changed = !(newPlaylist.length === cachedPlaylist.length &&
                        newPlaylist.every((item, i) => item.name === cachedPlaylist[i].name));
      if (changed) {
        logger.info('Cache updated (content changed)', { requestId, newCount: newPlaylist.length });
        cachedPlaylist = newPlaylist;
        cacheTime = now;
        await saveToD1(env, newPlaylist, now, requestId);
        return newPlaylist;
      } else {
        logger.info('Cache refreshed (no change)', { requestId });
        cacheTime = now;
        await saveToD1(env, cachedPlaylist, now, requestId);
        return cachedPlaylist;
      }
    } catch (error) {
      logger.error('Refresh failed, using old cache', { requestId, error: error.message });
      return cachedPlaylist;
    }
  }

  // 3. D1 也无有效数据，从源获取
  logger.info('No valid cache found, fetching from source', { requestId });
  try {
    const playlist = await fetchPlaylistFromApiTxt(env, requestId);
    cachedPlaylist = playlist;
    cacheTime = now;
    await saveToD1(env, playlist, now, requestId);
    return playlist;
  } catch (error) {
    // 如果 D1 有旧数据（即使过期）且获取失败，可以回退到旧数据？这里按需求返回错误
    if (d1Data) {
      logger.warn('Source fetch failed, using expired D1 cache', { requestId });
      cachedPlaylist = d1Data.playlist;
      cacheTime = d1Data.cacheTime;
      return cachedPlaylist;
    }
    throw new Error('读取回源仓库异常');
  }
}

// ========== 路由处理 ==========
async function handleRequest(request, env) {
  const requestId = crypto.randomUUID();
  const startTime = Date.now();
  const clientIp = getClientIp(request);
  const baseContext = { requestId, clientIp, method: request.method, url: request.url };

  // 初始化 logger
  if (!logger) logger = new Logger(env);
  logger.info('Request started', baseContext);

  // 确保 D1 表存在（仅一次，但可接受）
  await initD1(env, requestId);

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, '');

  // OPTIONS 预检
  if (request.method === 'OPTIONS') {
    logger.debug('OPTIONS request', baseContext);
    const response = new Response(null, { headers: corsHeaders() });
    const duration = Date.now() - startTime;
    logger.info('Request completed', { ...baseContext, status: 204, duration });
    return response;
  }

  try {
    let response = null;

    // 1. 纯文本格式 /api.txt
    if (path === 'api.txt') {
      const playlist = await getPlaylist(env, requestId);
      const textList = playlist.map(item => {
        const name = item.name.slice(0, -4);
        const dashSpaceIndex = name.indexOf(' - ');
        return dashSpaceIndex !== -1
          ? name.slice(0, dashSpaceIndex) + '-' + name.slice(dashSpaceIndex + 3)
          : name;
      }).join('\n');
      response = new Response(textList, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
      });
    }

    // 2. JSON 播放列表
    else if (path === 'api' || path === 'api/playlist' || path === '') {
      const playlist = await getPlaylist(env, requestId);
      response = new Response(JSON.stringify({
        code: 200,
        message: 'success',
        data: { total: playlist.length, list: playlist }
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // 3. 随机歌曲
    else if (path === 'api/random') {
      const playlist = await getPlaylist(env, requestId);
      if (playlist.length === 0) {
        response = new Response(JSON.stringify({ code: 404, message: 'No music found', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      } else {
        const randomItem = playlist[Math.floor(Math.random() * playlist.length)];
        response = new Response(JSON.stringify({ code: 200, message: 'success', data: randomItem }, null, 2), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
    }

    // 4. 手动更新缓存（从源获取并写入内存+D1）
    else if (path === 'api/update') {
      try {
        const newPlaylist = await fetchPlaylistFromApiTxt(env, requestId);
        cachedPlaylist = newPlaylist;
        cacheTime = Date.now();
        await saveToD1(env, newPlaylist, cacheTime, requestId);
        logger.info('Manual cache update successful', { requestId, count: newPlaylist.length });
        response = new Response(JSON.stringify({
          code: 200,
          message: 'Cache updated successfully',
          data: { total: newPlaylist.length, list: newPlaylist }
        }, null, 2), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      } catch (error) {
        logger.error('Manual cache update failed', { requestId, error: error.message });
        response = new Response(JSON.stringify({ code: 500, message: 'Update failed: ' + error.message, data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
    }

    // 5. 强制刷新（清空内存和D1，然后重新获取）
    else if (path === 'api/refresh') {
      cachedPlaylist = null;
      cacheTime = 0;
      await deleteFromD1(env, requestId);
      const playlist = await getPlaylist(env, requestId);
      logger.info('Cache force refreshed', { requestId, count: playlist.length });
      response = new Response(JSON.stringify({
        code: 200,
        message: 'Playlist refreshed',
        data: { total: playlist.length, list: playlist }
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // 6. 搜索
    else if (path === 'api/search') {
      const query = url.searchParams.get('q') || '';
      if (!query) {
        response = new Response(JSON.stringify({ code: 400, message: '缺少搜索关键词', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      } else if (query.length > MAX_SEARCH_LENGTH) {
        response = new Response(JSON.stringify({ code: 400, message: '搜索关键词过长', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      } else {
        const playlist = await getPlaylist(env, requestId);
        const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(safeQuery, 'i');
        const results = playlist.filter(item =>
          regex.test(item.title) ||
          regex.test(item.artist) ||
          regex.test(item.name)
        );
        response = new Response(JSON.stringify({
          code: 200,
          message: 'success',
          data: { total: results.length, query: query.substring(0, MAX_SEARCH_LENGTH), list: results }
        }, null, 2), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
    }

    // 7. 代理音乐文件
    else if (path.startsWith('api/music/')) {
      const filename = decodeURIComponent(path.replace('api/music/', ''));
      const cleanName = sanitizeFilename(filename.split('/').pop().split('\\').pop());
      if (!cleanName.toLowerCase().endsWith('.mp3')) {
        response = new Response(JSON.stringify({ code: 400, message: '非法文件类型', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      } else if (cleanName.length > MAX_FILENAME_LENGTH) {
        response = new Response(JSON.stringify({ code: 400, message: '文件名过长', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      } else {
        const baseUrl = env.BASE_URL;
        if (!baseUrl) throw new Error('BASE_URL 未设置');
        const normalizedBase = normalizeBaseUrl(baseUrl);
        const musicUrl = `${normalizedBase}${MUSIC_DIR}${encodeURIComponent(cleanName)}`;
        const resp = await fetch(musicUrl);
        if (!resp.ok) {
          logger.warn('Music file not found', { requestId, url: musicUrl, status: resp.status });
          response = new Response(JSON.stringify({ code: 404, message: '音乐文件不存在', data: null }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        } else {
          const contentType = resp.headers.get('Content-Type') || '';
          if (!contentType.includes('audio/') && !contentType.includes('application/octet-stream')) {
            response = new Response(JSON.stringify({ code: 400, message: '非法文件类型', data: null }), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders() }
            });
          } else {
            const contentLength = resp.headers.get('Content-Length');
            if (contentLength && parseInt(contentLength, 10) > MAX_MUSIC_FILE_SIZE) {
              response = new Response(JSON.stringify({ code: 400, message: '文件过大', data: null }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders() }
              });
            } else {
              response = new Response(resp.body, {
                headers: {
                  'Content-Type': 'audio/mpeg',
                  'Content-Disposition': `inline; filename="${escapeHeaderValue(cleanName)}"`,
                  'Accept-Ranges': 'bytes',
                  ...corsHeaders()
                }
              });
            }
          }
        }
      }
    }

    // 8. 代理歌词文件
    else if (path.startsWith('api/lrc/')) {
      const filename = decodeURIComponent(path.replace('api/lrc/', ''));
      const cleanName = sanitizeFilename(filename.split('/').pop().split('\\').pop());
      if (!cleanName.toLowerCase().endsWith('.lrc')) {
        response = new Response(JSON.stringify({ code: 400, message: '非法文件类型', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      } else if (cleanName.length > MAX_FILENAME_LENGTH) {
        response = new Response(JSON.stringify({ code: 400, message: '文件名过长', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      } else {
        const baseUrl = env.BASE_URL;
        if (!baseUrl) throw new Error('BASE_URL 未设置');
        const normalizedBase = normalizeBaseUrl(baseUrl);
        const lrcUrl = `${normalizedBase}${LRC_DIR}${encodeURIComponent(cleanName)}`;
        const resp = await fetch(lrcUrl);
        if (!resp.ok) {
          response = new Response('', {
            headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
          });
        } else {
          const contentType = resp.headers.get('Content-Type') || '';
          if (!contentType.includes('text/') && !contentType.includes('application/octet-stream')) {
            response = new Response('', {
              headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
            });
          } else {
            const contentLength = resp.headers.get('Content-Length');
            if (contentLength && parseInt(contentLength, 10) > MAX_LRC_FILE_SIZE) {
              response = new Response('', {
                headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
              });
            } else {
              response = new Response(resp.body, {
                headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
              });
            }
          }
        }
      }
    }

    // 默认 404
    else {
      response = new Response(JSON.stringify({ code: 404, message: 'API endpoint not found', data: null }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    const duration = Date.now() - startTime;
    logger.info('Request completed', { ...baseContext, status: response.status, duration });
    return response;

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Request failed', { ...baseContext, error: error.message, duration });
    if (error.message === '读取回源仓库异常') {
      return new Response('读取回源仓库异常', {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
      });
    }
    return new Response(JSON.stringify({ code: 500, message: 'Server error: ' + error.message, data: null }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

// ========== 入口 ==========
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};