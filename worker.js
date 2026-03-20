// ========== 常量配置 ==========
const MUSIC_DIR = 'music/';
const LRC_DIR   = 'lrc/';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30天

let cachedPlaylist = null;
let cacheTime = 0;

// ========== 工具函数 ==========
function parseFilename(filename) {
  const nameWithoutExt = filename.replace(/\.(mp3|lrc)$/i, '');
  let artist = '';
  let title = nameWithoutExt;

  if (nameWithoutExt.includes(' - ')) {
    const parts = nameWithoutExt.split(' - ');
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  } else if (nameWithoutExt.includes('-')) {
    const parts = nameWithoutExt.split('-');
    if (parts.length >= 2) {
      artist = parts[0].trim();
      title = parts.slice(1).join('-').trim();
    }
  }

  return { artist, title };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ========== 核心：获取播放列表（仅依赖 BASE_URL + api.txt） ==========
async function getPlaylist(env) {
  const now = Date.now();
  if (cachedPlaylist && (now - cacheTime) < CACHE_TTL) {
    return cachedPlaylist;
  }

  const baseUrl = env.BASE_URL;
  if (!baseUrl) {
    throw new Error('环境变量 BASE_URL 未设置');
  }

  // 确保 baseUrl 以斜杠结尾
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const apiTxtUrl = `${normalizedBase}api.txt`;

  try {
    const response = await fetch(apiTxtUrl, {
      headers: { 'User-Agent': 'Cloudflare-Worker' }
    });

    if (!response.ok) {
      throw new Error(`获取 api.txt 失败: ${response.status}`);
    }

    const text = await response.text();
    const lines = text.split('\n').filter(line => line.trim() !== '');

    if (lines.length === 0) {
      throw new Error('api.txt 为空');
    }

    // 生成播放列表
    const playlist = lines.map((line, index) => {
      // 去除行首的数字前缀（如 "1乌托邦P-反乌托邦" → "乌托邦P-反乌托邦"）
      let rawName = line.trim().replace(/^\d+/, '');
      // 确保以 .mp3 结尾
      if (!rawName.toLowerCase().endsWith('.mp3')) {
        rawName += '.mp3';
      }

      const info = parseFilename(rawName);
      const baseName = rawName.replace('.mp3', '');

      // 构造音乐 URL
      const musicUrl = `${normalizedBase}${MUSIC_DIR}${encodeURIComponent(rawName)}`;
      // 构造歌词 URL（对应 .lrc 文件）
      const lrcUrl = `${normalizedBase}${LRC_DIR}${encodeURIComponent(baseName + '.lrc')}`;

      return {
        id: index + 1,
        name: rawName,
        artist: info.artist,
        title: info.title,
        url: musicUrl,
        lrc: lrcUrl,   // 直接提供 URL，由前端处理 404
      };
    });

    // 更新缓存
    cachedPlaylist = playlist;
    cacheTime = now;
    return cachedPlaylist;

  } catch (error) {
    console.error('读取 api.txt 失败:', error);
    // 若已有缓存，可返回缓存（但此处要求失败返回502，故抛出错误）
    throw new Error('读取回源仓库异常');
  }
}

// ========== 路由处理 ==========
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, '');

  // OPTIONS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    // 1. 返回纯文本格式的歌曲列表（与原始 api.txt 格式相似）
    if (path === 'api.txt') {
      const playlist = await getPlaylist(env);
      const textList = playlist.map(item => {
        let name = item.name.replace('.mp3', '');
        // 恢复成 api.txt 格式（去除空格分隔的 " - "）
        if (name.includes(' - ')) {
          name = name.replace(' - ', '-');
        }
        return name;
      }).join('\n');
      return new Response(textList, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
      });
    }

    // 2. 返回 JSON 播放列表
    if (path === 'api' || path === 'api/playlist' || path === '') {
      const playlist = await getPlaylist(env);
      return new Response(JSON.stringify({
        code: 200,
        message: 'success',
        data: { total: playlist.length, list: playlist }
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // 3. 随机歌曲
    if (path === 'api/random') {
      const playlist = await getPlaylist(env);
      if (playlist.length === 0) {
        return new Response(JSON.stringify({ code: 404, message: 'No music found', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
      const randomItem = playlist[Math.floor(Math.random() * playlist.length)];
      return new Response(JSON.stringify({ code: 200, message: 'success', data: randomItem }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // 4. 强制刷新缓存
    if (path === 'api/refresh') {
      cachedPlaylist = null;
      cacheTime = 0;
      const playlist = await getPlaylist(env);
      return new Response(JSON.stringify({
        code: 200,
        message: 'Playlist refreshed',
        data: { total: playlist.length, list: playlist }
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // 5. 搜索
    if (path === 'api/search') {
      const query = url.searchParams.get('q') || '';
      if (!query) {
        return new Response(JSON.stringify({ code: 400, message: '缺少搜索关键词', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
      const playlist = await getPlaylist(env);
      const results = playlist.filter(item =>
        item.title.toLowerCase().includes(query.toLowerCase()) ||
        item.artist.toLowerCase().includes(query.toLowerCase()) ||
        item.name.toLowerCase().includes(query.toLowerCase())
      );
      return new Response(JSON.stringify({
        code: 200,
        message: 'success',
        data: { total: results.length, query, list: results }
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // 6. 代理音乐文件
    if (path.startsWith('api/music/')) {
      const filename = decodeURIComponent(path.replace('api/music/', ''));
      const cleanName = filename.split('/').pop().split('\\').pop();
      const baseUrl = env.BASE_URL;
      if (!baseUrl) throw new Error('BASE_URL 未设置');
      const normalizedBase = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
      const musicUrl = `${normalizedBase}${MUSIC_DIR}${encodeURIComponent(cleanName)}`;

      const resp = await fetch(musicUrl);
      if (!resp.ok) {
        return new Response(JSON.stringify({ code: 404, message: '音乐文件不存在', data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
      return new Response(resp.body, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Disposition': `inline; filename="${cleanName}"`,
          ...corsHeaders()
        }
      });
    }

    // 7. 代理歌词文件
    if (path.startsWith('api/lrc/')) {
      const filename = decodeURIComponent(path.replace('api/lrc/', ''));
      const cleanName = filename.split('/').pop().split('\\').pop();
      const baseUrl = env.BASE_URL;
      if (!baseUrl) throw new Error('BASE_URL 未设置');
      const normalizedBase = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
      const lrcUrl = `${normalizedBase}${LRC_DIR}${encodeURIComponent(cleanName)}`;

      const resp = await fetch(lrcUrl);
      if (!resp.ok) {
        // 歌词不存在时返回空字符串，避免 404
        return new Response('', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
        });
      }
      return new Response(resp.body, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
      });
    }

    // 其他路径返回 404
    return new Response(JSON.stringify({ code: 404, message: 'API endpoint not found', data: null }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });

  } catch (error) {
    console.error('请求处理错误:', error);
    // 如果是获取播放列表失败，返回 502 及指定信息
    if (error.message === '读取回源仓库异常') {
      return new Response('读取回源仓库异常', {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
      });
    }
    // 其他错误返回 500
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