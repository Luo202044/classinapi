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

// 允许的音频扩展名（白名单）
const ALLOWED_AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac']);

// 内存缓存
let cachedPlaylist = null;
let cacheTime = 0;
let cachedConfig = null;
let configCacheTime = 0;

// D1 表名
const CACHE_TABLE = 'cache';
const CACHE_KEY = 'playlist';
const SUPPOSE_TABLE = 'suppose';

let logger = null;

// ========== 优化后的日志模块（中文易读） ==========
class Logger {
  constructor(env) {
    const configuredLevel = (env && env.LOG_LEVEL) || 'INFO';
    const levelMap = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    this.level = levelMap[configuredLevel.toUpperCase()] ?? 1;
  }

  _formatMessage(level, message, context = {}) {
    const timestamp = new Date().toISOString();
    const contextStr = Object.entries(context)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return `[${level}] ${timestamp} - ${message} ${contextStr}`.trim();
  }

  _log(level, message, context) {
    if (this.level > level) return;
    const formatted = this._formatMessage(level, message, context);
    if (level === 2) console.warn(formatted);
    else if (level === 3) console.error(formatted);
    else console.log(formatted);
  }

  debug(msg, ctx) { this._log(0, msg, ctx); }
  info(msg, ctx)  { this._log(1, msg, ctx); }
  warn(msg, ctx)  { this._log(2, msg, ctx); }
  error(msg, ctx) { this._log(3, msg, ctx); }
}

// ========== 工具函数 ==========
function getContentTypeByExtension(filename) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.mp3': return 'audio/mpeg';
    case '.flac': return 'audio/flac';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.m4a': return 'audio/mp4';
    case '.aac': return 'audio/aac';
    default: return 'application/octet-stream';
  }
}

function parseFilename(filename) {
  const lastDotIndex = filename.lastIndexOf('.');
  let ext = '';
  let nameWithoutExt = filename;
  if (lastDotIndex !== -1) {
    ext = filename.slice(lastDotIndex + 1).toLowerCase();
    nameWithoutExt = filename.slice(0, lastDotIndex);
  }

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
  return { artist, title, ext };
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };
}

// ========== D1 初始化 ==========
async function initD1(env, requestId) {
  if (!env.DB) {
    logger.warn('D1 未绑定，使用内存缓存', { requestId });
    return false;
  }
  try {
    // 缓存表
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS ${CACHE_TABLE} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
    // 反馈表
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS ${SUPPOSE_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        main TEXT NOT NULL,
        user_ua TEXT,
        time INTEGER NOT NULL
      )
    `).run();
    logger.debug('D1 表准备就绪', { requestId });
    return true;
  } catch (err) {
    logger.error('D1 表初始化失败', { requestId, error: err.message });
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
      logger.debug('从 D1 加载缓存', { requestId, updated_at: result.updated_at });
      return {
        playlist: JSON.parse(result.value),
        cacheTime: result.updated_at
      };
    }
  } catch (err) {
    logger.error('从 D1 加载失败', { requestId, error: err.message });
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
    logger.debug('保存到 D1', { requestId, count: playlist.length, cacheTime });
    return true;
  } catch (err) {
    logger.error('保存到 D1 失败', { requestId, error: err.message });
    return false;
  }
}

async function deleteFromD1(env, requestId) {
  if (!env.DB) return false;
  try {
    const stmt = env.DB.prepare(`DELETE FROM ${CACHE_TABLE} WHERE key = ?`).bind(CACHE_KEY);
    await stmt.run();
    logger.debug('从 D1 删除缓存', { requestId });
    return true;
  } catch (err) {
    logger.error('从 D1 删除失败', { requestId, error: err.message });
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
    logger.debug('从 KV 读取 base_url', { requestId, baseUrl });
  }
  if (!baseUrl && env.BASE_URL) {
    baseUrl = env.BASE_URL;
    logger.debug('回退到环境变量 BASE_URL', { requestId, baseUrl });
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
  logger.debug('正在拉取 api.txt', { requestId, url: apiTxtUrl });
  const response = await fetch(apiTxtUrl, { headers: { 'User-Agent': 'Cloudflare-Worker' } });
  const fetchDuration = Date.now() - fetchStart;
  if (!response.ok) {
    logger.error('拉取 api.txt 失败', { requestId, status: response.status, duration: fetchDuration });
    throw new Error(`获取 api.txt 失败: ${response.status}`);
  }

  const text = await response.text();
  const lines = text.split('\n').filter(line => line.trim() !== '');
  if (lines.length === 0) {
    logger.warn('api.txt 为空', { requestId });
    throw new Error('api.txt 为空');
  }

  const playlist = lines.map((line, index) => {
    let rawName = line.trim().replace(/^\d+/, '');
    if (!rawName.includes('.')) {
      rawName += '.mp3';
    }
    const info = parseFilename(rawName);
    const lastDot = rawName.lastIndexOf('.');
    const baseName = lastDot !== -1 ? rawName.substring(0, lastDot) : rawName;
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

  logger.info('播放列表拉取成功', { requestId, count: playlist.length, duration: fetchDuration });
  return playlist;
}

// ========== 获取播放列表（内存 + D1）==========
async function getPlaylist(env, requestId) {
  const now = Date.now();

  // 1. 尝试从内存读取
  if (cachedPlaylist && (now - cacheTime) < CACHE_TTL) {
    logger.debug('内存缓存命中', { requestId, age: now - cacheTime });
    if ((now - cacheTime) < REFRESH_INTERVAL) {
      return cachedPlaylist;
    }
    logger.info('触发缓存刷新（内存）', { requestId });
    try {
      const newPlaylist = await fetchPlaylistFromApiTxt(env, requestId);
      const changed = !(newPlaylist.length === cachedPlaylist.length &&
                        newPlaylist.every((item, i) => item.name === cachedPlaylist[i].name));
      if (changed) {
        logger.info('缓存已更新（内容变化）', { requestId, newCount: newPlaylist.length });
        cachedPlaylist = newPlaylist;
        cacheTime = now;
        await saveToD1(env, newPlaylist, now, requestId);
        return newPlaylist;
      } else {
        logger.info('缓存刷新（内容无变化）', { requestId });
        cacheTime = now;
        await saveToD1(env, cachedPlaylist, now, requestId);
        return cachedPlaylist;
      }
    } catch (error) {
      logger.error('刷新失败，使用旧缓存', { requestId, error: error.message });
      return cachedPlaylist;
    }
  }

  // 2. 内存未命中或已过期，尝试从 D1 加载
  logger.debug('内存缓存未命中或已过期', { requestId, cacheExists: !!cachedPlaylist, cacheAge: cacheTime ? now - cacheTime : null });
  const d1Data = await loadFromD1(env, requestId);
  if (d1Data && (now - d1Data.cacheTime) < CACHE_TTL) {
    logger.info('从 D1 加载，更新内存', { requestId, age: now - d1Data.cacheTime });
    cachedPlaylist = d1Data.playlist;
    cacheTime = d1Data.cacheTime;
    if ((now - cacheTime) < REFRESH_INTERVAL) {
      return cachedPlaylist;
    }
    logger.info('触发缓存刷新（D1）', { requestId });
    try {
      const newPlaylist = await fetchPlaylistFromApiTxt(env, requestId);
      const changed = !(newPlaylist.length === cachedPlaylist.length &&
                        newPlaylist.every((item, i) => item.name === cachedPlaylist[i].name));
      if (changed) {
        logger.info('缓存已更新（内容变化）', { requestId, newCount: newPlaylist.length });
        cachedPlaylist = newPlaylist;
        cacheTime = now;
        await saveToD1(env, newPlaylist, now, requestId);
        return newPlaylist;
      } else {
        logger.info('缓存刷新（内容无变化）', { requestId });
        cacheTime = now;
        await saveToD1(env, cachedPlaylist, now, requestId);
        return cachedPlaylist;
      }
    } catch (error) {
      logger.error('刷新失败，使用旧缓存', { requestId, error: error.message });
      return cachedPlaylist;
    }
  }

  // 3. D1 也无有效数据，从源获取
  logger.info('无有效缓存，从源站获取', { requestId });
  try {
    const playlist = await fetchPlaylistFromApiTxt(env, requestId);
    cachedPlaylist = playlist;
    cacheTime = now;
    await saveToD1(env, playlist, now, requestId);
    return playlist;
  } catch (error) {
    if (d1Data) {
      logger.warn('源站获取失败，使用过期 D1 缓存', { requestId });
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
  cachedPlaylist = null;
  cacheTime = 0;
  await deleteFromD1(env, requestId);
  logger.info('配置和播放列表缓存已清除', { requestId });
}

async function reloadMusic(env, requestId) {
  cachedPlaylist = null;
  cacheTime = 0;
  await deleteFromD1(env, requestId);
  const playlist = await getPlaylist(env, requestId);
  logger.info('音乐缓存已重载', { requestId, count: playlist.length });
  return playlist;
}

async function verifyAdminToken(env, request, requestId) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return false;

  if (!env.CONFIG_KV) {
    logger.warn('CONFIG_KV 未绑定，管理端点禁用', { requestId });
    return false;
  }

  const configToken = await env.CONFIG_KV.get('config_token', 'text');
  if (!configToken) {
    logger.warn('config_token 未配置，管理端点禁用', { requestId });
    return false;
  }

  return token === configToken;
}

// ========== 反馈专用 Token 验证（多 token，逗号分隔） ==========
async function verifySuppostToken(env, request, requestId) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return false;

  if (!env.CONFIG_KV) {
    logger.warn('CONFIG_KV 未绑定，反馈端点禁用', { requestId });
    return false;
  }

  const tokensStr = await env.CONFIG_KV.get('suppost_tokens', 'text');
  if (!tokensStr) {
    logger.warn('suppost_tokens 未配置', { requestId });
    return false;
  }

  const validTokens = tokensStr.split(',').map(t => t.trim());
  const isValid = validTokens.includes(token);
  if (!isValid) {
    logger.warn('反馈 token 验证失败', { requestId });
  }
  return isValid;
}

// ========== 新增：获取反馈列表 ==========
async function getFeedbackList(env, request, requestId) {
  const url = new URL(request.url);
  let page = parseInt(url.searchParams.get('page')) || 1;
  let limit = parseInt(url.searchParams.get('limit')) || 20;

  if (page < 1) page = 1;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;

  const offset = (page - 1) * limit;

  if (!env.DB) {
    logger.error('D1 未绑定，无法获取反馈列表', { requestId });
    return new Response(JSON.stringify({ code: 500, message: '数据库未配置', data: null }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  try {
    // 获取总数
    const countResult = await env.DB.prepare(`SELECT COUNT(*) as total FROM ${SUPPOSE_TABLE}`).first();
    const total = countResult ? countResult.total : 0;

    // 获取分页数据，按 time 倒序
    const stmt = env.DB.prepare(`
      SELECT id, user_id, title, main, user_ua, time
      FROM ${SUPPOSE_TABLE}
      ORDER BY time DESC
      LIMIT ? OFFSET ?
    `).bind(limit, offset);
    const rows = await stmt.all();

    const list = rows.results.map(row => ({
      id: row.id,
      user_id: row.user_id,
      title: row.title,
      main: row.main,
      user_ua: row.user_ua || '',
      time: row.time
    }));

    const pagination = {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit)
    };

    logger.info('获取反馈列表成功', { requestId, total, returned: list.length });
    return new Response(JSON.stringify({
      code: 200,
      message: 'success',
      data: { list, pagination }
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (err) {
    logger.error('获取反馈列表失败', { requestId, error: err.message });
    return new Response(JSON.stringify({ code: 500, message: '服务器错误', data: null }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

// ========== 新增：删除反馈 ==========
async function deleteFeedback(env, request, requestId) {
  const url = new URL(request.url);
  const idParam = url.searchParams.get('id');
  if (!idParam) {
    return new Response(JSON.stringify({ code: 400, message: '缺少反馈ID', data: null }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
  const id = parseInt(idParam);
  if (isNaN(id)) {
    return new Response(JSON.stringify({ code: 400, message: '反馈ID格式错误', data: null }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  if (!env.DB) {
    logger.error('D1 未绑定，无法删除反馈', { requestId });
    return new Response(JSON.stringify({ code: 500, message: '数据库未配置', data: null }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  try {
    // 先检查是否存在
    const checkStmt = env.DB.prepare(`SELECT id FROM ${SUPPOSE_TABLE} WHERE id = ?`).bind(id);
    const exists = await checkStmt.first();
    if (!exists) {
      return new Response(JSON.stringify({ code: 404, message: '反馈记录不存在', data: null }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    const deleteStmt = env.DB.prepare(`DELETE FROM ${SUPPOSE_TABLE} WHERE id = ?`).bind(id);
    await deleteStmt.run();
    logger.info('反馈删除成功', { requestId, id });
    return new Response(JSON.stringify({ code: 200, message: 'success', data: null }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (err) {
    logger.error('删除反馈失败', { requestId, id, error: err.message });
    return new Response(JSON.stringify({ code: 500, message: '删除失败', data: null }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

// ========== 新增：提交反馈 ==========
async function addFeedback(env, request, requestId) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ code: 400, message: '请求体格式错误', data: null }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  const { user_id, title, main, user_ua: clientUa } = body;

  // 校验必填字段
  if (!user_id || typeof user_id !== 'string' || user_id.trim() === '') {
    return new Response(JSON.stringify({ code: 400, message: '缺少必填字段: user_id', data: null }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
  if (!title || typeof title !== 'string' || title.trim() === '') {
    return new Response(JSON.stringify({ code: 400, message: '缺少必填字段: title', data: null }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
  if (!main || typeof main !== 'string' || main.trim() === '') {
    return new Response(JSON.stringify({ code: 400, message: '缺少必填字段: main', data: null }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  // 长度限制
  const trimmedUserId = user_id.trim().slice(0, 50);
  const trimmedTitle = title.trim().slice(0, 100);
  let trimmedMain = main.trim();
  if (trimmedMain.length > 350) trimmedMain = trimmedMain.slice(0, 350);
  // user_ua 处理：优先客户端传入，否则从请求头获取
  let finalUa = '';
  if (clientUa && typeof clientUa === 'string' && clientUa.trim() !== '') {
    finalUa = clientUa.trim().slice(0, 500);
  } else {
    const uaHeader = request.headers.get('User-Agent') || '';
    finalUa = uaHeader.slice(0, 500);
  }

  const time = Math.floor(Date.now() / 1000); // Unix 时间戳（秒）

  if (!env.DB) {
    logger.error('D1 未绑定，无法提交反馈', { requestId });
    return new Response(JSON.stringify({ code: 500, message: '数据库未配置', data: null }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  try {
    const stmt = env.DB.prepare(`
      INSERT INTO ${SUPPOSE_TABLE} (user_id, title, main, user_ua, time)
      VALUES (?, ?, ?, ?, ?)
    `).bind(trimmedUserId, trimmedTitle, trimmedMain, finalUa, time);
    const result = await stmt.run();
    const newId = result.meta.last_row_id;
    logger.info('反馈提交成功', { requestId, id: newId, user_id: trimmedUserId });
    return new Response(JSON.stringify({
      code: 200,
      message: '反馈提交成功',
      data: { id: newId }
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (err) {
    logger.error('反馈提交失败', { requestId, error: err.message });
    return new Response(JSON.stringify({ code: 500, message: '提交失败，请稍后重试', data: null }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

// ========== 主请求处理 ==========
async function handleRequest(request, env) {
  const requestId = crypto.randomUUID();
  const startTime = Date.now();
  const clientIp = getClientIp(request);

  // 过滤URL中的敏感token参数
  const sanitizedUrl = new URL(request.url);
  if (sanitizedUrl.searchParams.has('token')) {
    sanitizedUrl.searchParams.set('token', '***');
  }
  const baseContext = { requestId, clientIp, method: request.method, url: sanitizedUrl.toString() };

  if (!logger) logger = new Logger(env);
  logger.info('请求开始', baseContext);

  await initD1(env, requestId);

  // OPTIONS 预检
  if (request.method === 'OPTIONS') {
    logger.debug('OPTIONS 预检请求', baseContext);
    const response = new Response(null, { headers: corsHeaders() });
    const duration = Date.now() - startTime;
    logger.info('请求完成', { ...baseContext, status: 204, duration });
    return response;
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, '');

  try {
    let response = null;

    // ========== 管理端点 ==========
    if (path === 'api/ser/reload') {
      const valid = await verifyAdminToken(env, request, requestId);
      if (!valid) {
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

    // ========== 反馈系统端点 ==========
    else if (path === 'api/suppost/list/get') {
      const valid = await verifySuppostToken(env, request, requestId);
      if (!valid) {
        return new Response(JSON.stringify({ code: 502, message: 'Bad Gateway', data: null }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
      response = await getFeedbackList(env, request, requestId);
    }
    else if (path === 'api/suppost/list/del') {
      const valid = await verifySuppostToken(env, request, requestId);
      if (!valid) {
        return new Response(JSON.stringify({ code: 502, message: 'Bad Gateway', data: null }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
      response = await deleteFeedback(env, request, requestId);
    }
    else if (path === 'api/suppost/add') {
      // 仅支持 POST
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ code: 405, message: 'Method Not Allowed', data: null }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
      response = await addFeedback(env, request, requestId);
    }

    // ========== 原有路由 ==========
    else if (path === 'api.txt') {
      const playlist = await getPlaylist(env, requestId);
      const textList = playlist.map(item => {
        const nameWithoutExt = item.name.replace(/\.[^.]+$/, '');
        const dashSpaceIndex = nameWithoutExt.indexOf(' - ');
        return dashSpaceIndex !== -1
          ? nameWithoutExt.slice(0, dashSpaceIndex) + '-' + nameWithoutExt.slice(dashSpaceIndex + 3)
          : nameWithoutExt;
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
        response = new Response(JSON.stringify({
          code: 200, message: 'Cache updated successfully', data: { total: newPlaylist.length, list: newPlaylist }
        }, null, 2), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      } catch (error) {
        logger.error('手动更新缓存失败', { requestId, error: error.message });
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
      const ext = cleanName.slice(cleanName.lastIndexOf('.')).toLowerCase();
      if (!ALLOWED_AUDIO_EXT.has(ext)) {
        response = new Response(JSON.stringify({ code: 400, message: '不支持的文件类型', data: null }), {
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
          logger.warn('音乐文件不存在', { requestId, url: musicUrl, status: resp.status });
          response = new Response(JSON.stringify({ code: 404, message: '音乐文件不存在', data: null }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        } else {
          const contentLength = resp.headers.get('Content-Length');
          if (contentLength && parseInt(contentLength, 10) > MAX_MUSIC_FILE_SIZE) {
            response = new Response(JSON.stringify({ code: 400, message: '文件过大', data: null }), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders() }
            });
          } else {
            const contentType = getContentTypeByExtension(cleanName);
            response = new Response(resp.body, {
              headers: {
                'Content-Type': contentType,
                'Content-Disposition': `inline; filename="${escapeHeaderValue(cleanName)}"`,
                'Accept-Ranges': 'bytes',
                ...corsHeaders()
              }
            });
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
    else {
      response = new Response(JSON.stringify({ code: 404, message: 'API endpoint not found', data: null }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    const duration = Date.now() - startTime;
    logger.info('请求完成', { ...baseContext, status: response.status, duration });
    return response;

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('请求失败', { ...baseContext, error: error.message, duration });
    if (error.message === '读取回源仓库异常') {
      return new Response('读取回源仓库异常', {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
      });
    }
    const isProduction = env.ENVIRONMENT === 'production';
    const errorMessage = isProduction ? 'Internal Server Error' : '服务器错误: ' + error.message;
    return new Response(JSON.stringify({ code: 500, message: errorMessage, data: null }), {
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
