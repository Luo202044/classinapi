// ========== 常量配置 ==========
const MUSIC_DIR = 'music/';
const LRC_DIR   = 'lrc/';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;   // 30天
const REFRESH_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7天
const MAX_FILENAME_LENGTH = 255;
const MAX_SEARCH_LENGTH = 200;
const MAX_MUSIC_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_LRC_FILE_SIZE = 1024 * 1024;        // 1MB
const CONFIG_CACHE_TTL = 5 * 60 * 1000;       // 配置缓存5分钟

// 日志级别
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const DEFAULT_LOG_LEVEL = 'INFO';

// 内存缓存
let cachedPlaylist = null;
let cacheTime = 0;
let cachedConfig = null;
let configCacheTime = 0;

// D1 表名
const CACHE_TABLE = 'cache';
const CACHE_KEY = 'playlist';

let logger = null;

// ========== 日志模块 ==========
class Logger {
  constructor(env) {
    const configuredLevel = (env && env.LOG_LEVEL) || DEFAULT_LOG_LEVEL;
    this.level = LOG_LEVELS[configuredLevel.toUpperCase()] ?? LOG_LEVELS.INFO;
  }
  _log(level, message, context = {}) {
    if (LOG_LEVELS[level] < this.level) return;
    const entry = { timestamp: new Date().toISOString(), level, message, ...context };
    const consoleMethod = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    consoleMethod(JSON.stringify(entry));
  }
  debug(msg, ctx) { this._log('DEBUG', msg, ctx); }
  info(msg, ctx)  { this._log('INFO',  msg, ctx); }
  warn(msg, ctx)  { this._log('WARN',  msg, ctx); }
  error(msg, ctx) { this._log('ERROR', msg, ctx); }
}

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

// ========== D1 初始化 ==========
async function initD1(env, requestId) {
  if (!env.DB) {
    logger.warn('D1 not bound, using memory-only cache', { requestId });
    return false;
  }
  try {
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

// ========== D1 缓存操作 ==========
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

// ========== 配置获取（从 KV 或环境变量）==========
async function getConfig(env, requestId) {
  const now = Date.now();
  if (cachedConfig && (now - configCacheTime) < CONFIG_CACHE_TTL) {
    return cachedConfig;
  }

  let baseUrl = null;
  if (env.CONFIG_KV) {
    baseUrl = await env.CONFIG_KV.get('base_url', 'text');
    logger.debug('Read base_url from KV', { requestId, baseUrl });
  }
  if (!baseUrl && env.BASE_URL) {
    baseUrl = env.BASE_URL;
    logger.debug('Fallback to env BASE_URL', { requestId, baseUrl });
  }
  if (!baseUrl) {
    throw new Error('未配置 BASE_URL，请在 KV 或环境变量中设置');
  }

  cachedConfig = { baseUrl: normalizeBaseUrl(baseUrl) };
  configCacheTime = now;
  return cachedConfig;
}

// ========== 从 api.txt 获取播放列表 ==========
async function fetchPlaylistFromApiTxt(env, requestId) {
  const { baseUrl } = await getConfig(env, requestId);
  const apiTxtUrl = `${baseUrl}api.txt`;

  const fetchStart = Date.now();
  logger.debug('Fetching api.txt', { requestId, url: apiTxtUrl });
  const response = await fetch(apiTxtUrl, { headers: { 'User-Agent': 'Cloudflare-Worker' } });
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
    const musicUrl = `${baseUrl}${MUSIC_DIR}${encodeURIComponent(rawName)}`;
    const lrcUrl = `${baseUrl}${LRC_DIR}${encodeURIComponent(baseName + '.lrc')}`;
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

// ========== 获取播放列表（内存 + D1）==========
async function getPlaylist(env, requestId) {
  const now = Date.now();

  // 1. 尝试从内存读取
  if (cachedPlaylist && (now - cacheTime) < CACHE_TTL) {
    logger.debug('Memory cache hit', { requestId, age: now - cacheTime });
    if ((now - cacheTime) < REFRESH_INTERVAL) {
      return cachedPlaylist;
    }
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
    if ((now - cacheTime) < REFRESH_INTERVAL) {
      return cachedPlaylist;
    }
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
    if (d1Data) {
      logger.warn('Source fetch failed, using expired D1 cache', { requestId });
      cachedPlaylist = d1Data.playlist;
      cacheTime = d1Data.cacheTime;
      return cachedPlaylist;
    }
    throw new Error('读取回源仓库异常');
  }
}

// ========== 管理功能 ==========
async function reloadConfig(env, requestId) {
  cachedConfig = null;
  configCacheTime = 0;
  logger.info('Config cache cleared', { requestId });
  // 因为 base_url 变了，播放列表缓存也必须清除
  cachedPlaylist = null;
  cacheTime = 0;
  await deleteFromD1(env, requestId);
  logger.info('Playlist cache cleared due to config change', { requestId });
}

async function reloadMusic(env, requestId) {
  cachedPlaylist = null;
  cacheTime = 0;
  await deleteFromD1(env, requestId);
  const playlist = await getPlaylist(env, requestId);
  logger.info('Music cache reloaded', { requestId, count: playlist.length });
  return playlist;
}

async function verifyAdminToken(env, request, requestId) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return false;

  let configToken = '1234567890';  // 默认值
  if (env.CONFIG_KV) {
    const kvToken = await env.CONFIG_KV.get('config_token', 'text');
    if (kvToken !== null) configToken = kvToken;
    logger.debug('Read config_token from KV', { requestId, hasToken: !!kvToken });
  }
  return token === configToken;
}

// ========== 主请求处理 ==========
async function handleRequest(request, env) {
  const requestId = crypto.randomUUID();
  const startTime = Date.now();
  const clientIp = getClientIp(request);
  const baseContext = { requestId, clientIp, method: request.method, url: request.url };

  if (!logger) logger = new Logger(env);
  logger.info('Request started', baseContext);

  await initD1(env, requestId);

  // OPTIONS 预检
  if (request.method === 'OPTIONS') {
    logger.debug('OPTIONS request', baseContext);
    const response = new Response(null, { headers: corsHeaders() });
    const duration = Date.now() - startTime;
    logger.info('Request completed', { ...baseContext, status: 204, duration });
    return response;
  }

  // 速率限制（使用内置 Rate Limiting API）
  const rateLimiter = env.MY_RATE_LIMITER;
  if (rateLimiter) {
    const { success } = await rateLimiter.limit({ key: clientIp });
    if (!success) {
      logger.warn('Rate limit exceeded', { requestId, clientIp });
      return new Response(JSON.stringify({ code: 429, message: 'Too Many Requests', data: null }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
  } else {
    logger.warn('Rate limiter not bound', { requestId });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, '');

  try {
    let response = null;

    // ========== 管理端点 ==========
    if (path === 'api/ser/reload') {
      const valid = await verifyAdminToken(env, request, requestId);
      if (!valid) {
        logger.warn('Invalid admin token', { requestId, path });
        return new Response(JSON.stringify({ code: 502, message: 'Bad Gateway', data: null }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
      await reloadConfig(env, requestId);
      response = new Response(JSON.stringify({ code: 200, message: 'Config reloaded', data: null }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
    else if (path === 'api/ser/meload') {
      const valid = await verifyAdminToken(env, request, requestId);
      if (!valid) {
        logger.warn('Invalid admin token', { requestId, path });
        return new Response(JSON.stringify({ code: 502, message: 'Bad Gateway', data: null }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
      const playlist = await reloadMusic(env, requestId);
      response = new Response(JSON.stringify({
        code: 200,
        message: 'Music cache reloaded',
        data: { total: playlist.length, list: playlist }
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // ========== 原有路由 ==========
    else if (path === 'api.txt') {
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
    else if (path === 'api' || path === 'api/playlist' || path === '') {
      const playlist = await getPlaylist(env, requestId);
      response = new Response(JSON.stringify({
        code: 200, message: 'success', data: { total: playlist.length, list: playlist }
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
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
    else if (path === 'api/update') {
      try {
        const newPlaylist = await fetchPlaylistFromApiTxt(env, requestId);
        cachedPlaylist = newPlaylist;
        cacheTime = Date.now();
        await saveToD1(env, newPlaylist, cacheTime, requestId);
        logger.info('Manual cache update successful', { requestId, count: newPlaylist.length });
        response = new Response(JSON.stringify({
          code: 200, message: 'Cache updated successfully', data: { total: newPlaylist.length, list: newPlaylist }
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
    else if (path === 'api/refresh') {
      cachedPlaylist = null;
      cacheTime = 0;
      await deleteFromD1(env, requestId);
      const playlist = await getPlaylist(env, requestId);
      logger.info('Cache force refreshed', { requestId, count: playlist.length });
      response = new Response(JSON.stringify({
        code: 200, message: 'Playlist refreshed', data: { total: playlist.length, list: playlist }
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
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
          regex.test(item.title) || regex.test(item.artist) || regex.test(item.name)
        );
        response = new Response(JSON.stringify({
          code: 200, message: 'success', data: { total: results.length, query: query.substring(0, MAX_SEARCH_LENGTH), list: results }
        }, null, 2), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
    }
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
        const { baseUrl } = await getConfig(env, requestId);
        const musicUrl = `${baseUrl}${MUSIC_DIR}${encodeURIComponent(cleanName)}`;
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
        const { baseUrl } = await getConfig(env, requestId);
        const lrcUrl = `${baseUrl}${LRC_DIR}${encodeURIComponent(cleanName)}`;
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