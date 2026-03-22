// ========== 常量配置 ==========
const MUSIC_DIR = 'music/';
const LRC_DIR   = 'lrc/';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;   // 30天
const REFRESH_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7天
const RATE_LIMIT_WINDOW = 10 * 1000;          // 10秒窗口
const RATE_LIMIT_MAX_REQUESTS = 50;           // 最大请求次数
const MAX_FILENAME_LENGTH = 255;              // 最大文件名长度
const MAX_SEARCH_LENGTH = 200;                // 最大搜索长度
const MAX_MUSIC_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_LRC_FILE_SIZE = 1024 * 1024;        // 1MB

// 内存缓存
let cachedPlaylist = null;
let cacheTime = 0;

// 速率限制存储（IP -> 时间戳数组）
const ipRequestMap = new Map();

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
  // 只允许字母、数字、中文、空格、横线、下划线、点
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
  // 优先使用 Cloudflare 提供的真实 IP
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

// ========== 速率限制（惰性清理） ==========
function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  let requests = ipRequestMap.get(ip) || [];
  // 清理过期记录（二分查找加速）
  let left = 0, right = requests.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (requests[mid] <= windowStart) left = mid + 1;
    else right = mid;
  }
  if (left > 0) requests = requests.slice(left);
  if (requests.length >= RATE_LIMIT_MAX_REQUESTS) {
    return {
      allowed: false,
      remaining: 0,
      resetTime: requests[0] + RATE_LIMIT_WINDOW
    };
  }
  requests.push(now);
  ipRequestMap.set(ip, requests);
  return {
    allowed: true,
    remaining: RATE_LIMIT_MAX_REQUESTS - requests.length
  };
}

// ========== 核心：从 api.txt 获取播放列表 ==========
async function fetchPlaylistFromApiTxt(env) {
  const baseUrl = env.BASE_URL;
  if (!baseUrl) throw new Error('环境变量 BASE_URL 未设置');
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const apiTxtUrl = `${normalizedBase}api.txt`;

  const response = await fetch(apiTxtUrl, {
    headers: { 'User-Agent': 'Cloudflare-Worker' }
  });
  if (!response.ok) throw new Error(`获取 api.txt 失败: ${response.status}`);

  const text = await response.text();
  const lines = text.split('\n').filter(line => line.trim() !== '');
  if (lines.length === 0) throw new Error('api.txt 为空');

  const playlist = lines.map((line, index) => {
    let rawName = line.trim().replace(/^\d+/, ''); // 去除数字前缀
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
  return playlist;
}

// ========== 获取播放列表（含缓存与刷新策略） ==========
async function getPlaylist(env) {
  const now = Date.now();

  // 缓存存在且未超30天
  if (cachedPlaylist && (now - cacheTime) < CACHE_TTL) {
    // 未满7天，直接返回缓存
    if ((now - cacheTime) < REFRESH_INTERVAL) {
      return cachedPlaylist;
    }
    // 满7天，尝试刷新
    try {
      const newPlaylist = await fetchPlaylistFromApiTxt(env);
      // 比较歌曲数量和名称（避免 JSON.stringify 开销）
      if (newPlaylist.length === cachedPlaylist.length &&
          newPlaylist.every((item, i) => item.name === cachedPlaylist[i].name)) {
        // 内容相同，仅更新时间戳
        cacheTime = now;
        return cachedPlaylist;
      } else {
        // 内容变化，更新缓存
        cachedPlaylist = newPlaylist;
        cacheTime = now;
        return newPlaylist;
      }
    } catch (error) {
      console.error('刷新播放列表失败，继续使用旧缓存:', error);
      return cachedPlaylist;
    }
  }

  // 无缓存或缓存过期 → 强制获取
  try {
    const playlist = await fetchPlaylistFromApiTxt(env);
    cachedPlaylist = playlist;
    cacheTime = now;
    return playlist;
  } catch (error) {
    throw new Error('读取回源仓库异常');
  }
}

// ========== 路由处理 ==========
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, '');

  // 预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  // 速率限制检查
  const clientIp = getClientIp(request);
  const rateLimit = checkRateLimit(clientIp);
  const rateLimitHeaders = {
    'X-RateLimit-Limit': RATE_LIMIT_MAX_REQUESTS.toString(),
    'X-RateLimit-Remaining': rateLimit.remaining.toString(),
    'X-RateLimit-Reset': rateLimit.resetTime ? new Date(rateLimit.resetTime).toISOString() : '',
  };
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({
      code: 403,
      message: 'Too Many Requests',
      data: {
        limit: RATE_LIMIT_MAX_REQUESTS,
        window: RATE_LIMIT_WINDOW / 1000,
        resetAt: new Date(rateLimit.resetTime).toISOString()
      }
    }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': Math.ceil((rateLimit.resetTime - Date.now()) / 1000).toString(),
        ...corsHeaders(),
        ...rateLimitHeaders
      }
    });
  }

  try {
    // 1. 纯文本格式 /api.txt
    if (path === 'api.txt') {
      const playlist = await getPlaylist(env);
      const textList = playlist.map(item => {
        const name = item.name.slice(0, -4); // 去掉 .mp3
        const dashSpaceIndex = name.indexOf(' - ');
        return dashSpaceIndex !== -1
          ? name.slice(0, dashSpaceIndex) + '-' + name.slice(dashSpaceIndex + 3)
          : name;
      }).join('\n');
      return new Response(textList, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(), ...rateLimitHeaders }
      });
    }

    // 2. JSON 播放列表 /api, /api/playlist, 根路径
    if (path === 'api' || path === 'api/playlist' || path === '') {
      const playlist = await getPlaylist(env);
      return new Response(JSON.stringify({
        code: 200,
        message: 'success',
        data: { total: playlist.length, list: playlist }
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
      });
    }

    // 3. 随机歌曲
    if (path === 'api/random') {
      const playlist = await getPlaylist(env);
      if (playlist.length === 0) {
        return new Response(JSON.stringify({ code: 404, message: 'No music found', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
        });
      }
      const randomItem = playlist[Math.floor(Math.random() * playlist.length)];
      return new Response(JSON.stringify({ code: 200, message: 'success', data: randomItem }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
      });
    }

    // 4. 手动更新缓存（不刷新，直接获取）
    if (path === 'api/update') {
      try {
        const newPlaylist = await fetchPlaylistFromApiTxt(env);
        cachedPlaylist = newPlaylist;
        cacheTime = Date.now();
        console.log(`手动更新缓存成功: ${newPlaylist.length} 首歌曲`);
        return new Response(JSON.stringify({
          code: 200,
          message: 'Cache updated successfully',
          data: { total: newPlaylist.length, list: newPlaylist }
        }, null, 2), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
        });
      } catch (error) {
        console.error('手动更新缓存失败:', error);
        return new Response(JSON.stringify({ code: 500, message: 'Update failed: ' + error.message, data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
        });
      }
    }

    // 5. 强制刷新缓存（清空后重新获取）
    if (path === 'api/refresh') {
      cachedPlaylist = null;
      cacheTime = 0;
      const playlist = await getPlaylist(env);
      return new Response(JSON.stringify({
        code: 200,
        message: 'Playlist refreshed',
        data: { total: playlist.length, list: playlist }
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
      });
    }

    // 6. 搜索
    if (path === 'api/search') {
      const query = url.searchParams.get('q') || '';
      if (!query) {
        return new Response(JSON.stringify({ code: 400, message: '缺少搜索关键词', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
        });
      }
      if (query.length > MAX_SEARCH_LENGTH) {
        return new Response(JSON.stringify({ code: 400, message: '搜索关键词过长', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
        });
      }
      const playlist = await getPlaylist(env);
      const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(safeQuery, 'i');
      const results = playlist.filter(item =>
        regex.test(item.title) ||
        regex.test(item.artist) ||
        regex.test(item.name)
      );
      return new Response(JSON.stringify({
        code: 200,
        message: 'success',
        data: { total: results.length, query: query.substring(0, MAX_SEARCH_LENGTH), list: results }
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
      });
    }

    // 7. 代理音乐文件
    if (path.startsWith('api/music/')) {
      const filename = decodeURIComponent(path.replace('api/music/', ''));
      const cleanName = sanitizeFilename(filename.split('/').pop().split('\\').pop());
      if (!cleanName.toLowerCase().endsWith('.mp3')) {
        return new Response(JSON.stringify({ code: 400, message: '非法文件类型', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
        });
      }
      if (cleanName.length > MAX_FILENAME_LENGTH) {
        return new Response(JSON.stringify({ code: 400, message: '文件名过长', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
        });
      }
      const baseUrl = env.BASE_URL;
      if (!baseUrl) throw new Error('BASE_URL 未设置');
      const normalizedBase = normalizeBaseUrl(baseUrl);
      const musicUrl = `${normalizedBase}${MUSIC_DIR}${encodeURIComponent(cleanName)}`;
      const resp = await fetch(musicUrl);
      if (!resp.ok) {
        return new Response(JSON.stringify({ code: 404, message: '音乐文件不存在', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
        });
      }
      const contentType = resp.headers.get('Content-Type') || '';
      if (!contentType.includes('audio/') && !contentType.includes('application/octet-stream')) {
        return new Response(JSON.stringify({ code: 400, message: '非法文件类型', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
        });
      }
      const contentLength = resp.headers.get('Content-Length');
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (size > MAX_MUSIC_FILE_SIZE) {
          return new Response(JSON.stringify({ code: 400, message: '文件过大', data: null }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
          });
        }
      }
      return new Response(resp.body, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Disposition': `inline; filename="${escapeHeaderValue(cleanName)}"`,
          'Accept-Ranges': 'bytes',
          ...corsHeaders(),
          ...rateLimitHeaders
        }
      });
    }

    // 8. 代理歌词文件
    if (path.startsWith('api/lrc/')) {
      const filename = decodeURIComponent(path.replace('api/lrc/', ''));
      const cleanName = sanitizeFilename(filename.split('/').pop().split('\\').pop());
      if (!cleanName.toLowerCase().endsWith('.lrc')) {
        return new Response(JSON.stringify({ code: 400, message: '非法文件类型', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
        });
      }
      if (cleanName.length > MAX_FILENAME_LENGTH) {
        return new Response(JSON.stringify({ code: 400, message: '文件名过长', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
        });
      }
      const baseUrl = env.BASE_URL;
      if (!baseUrl) throw new Error('BASE_URL 未设置');
      const normalizedBase = normalizeBaseUrl(baseUrl);
      const lrcUrl = `${normalizedBase}${LRC_DIR}${encodeURIComponent(cleanName)}`;
      const resp = await fetch(lrcUrl);
      if (!resp.ok) {
        // 歌词不存在时返回空字符串，避免 404
        return new Response('', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(), ...rateLimitHeaders }
        });
      }
      const contentType = resp.headers.get('Content-Type') || '';
      if (!contentType.includes('text/') && !contentType.includes('application/octet-stream')) {
        return new Response('', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(), ...rateLimitHeaders }
        });
      }
      const contentLength = resp.headers.get('Content-Length');
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (size > MAX_LRC_FILE_SIZE) {
          return new Response('', {
            headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(), ...rateLimitHeaders }
          });
        }
      }
      return new Response(resp.body, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(), ...rateLimitHeaders }
      });
    }

    // 默认 404
    return new Response(JSON.stringify({ code: 404, message: 'API endpoint not found', data: null }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
    });

  } catch (error) {
    console.error('请求处理错误:', error);
    if (error.message === '读取回源仓库异常') {
      return new Response('读取回源仓库异常', {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(), ...rateLimitHeaders }
      });
    }
    return new Response(JSON.stringify({ code: 500, message: 'Server error: ' + error.message, data: null }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...rateLimitHeaders }
    });
  }
}

// ========== 入口 ==========
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};