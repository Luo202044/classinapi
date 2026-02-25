const MUSIC_DIR = 'music/';
const LRC_DIR = 'lrc/';
const BASE_URL = 'https://raw.githubusercontent.com/Luo202044/classinapi/main/';
const GITHUB_API = 'https://api.github.com/repos/Luo202044/classinapi/contents';

let cachedPlaylist = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchGitHubContent(path) {
  const response = await fetch(`${GITHUB_API}/${path}`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Cloudflare-Worker'
    }
  });
  if (!response.ok) {
    console.error(`GitHub API error: ${response.status} ${response.statusText}`);
    return [];
  }
  return await response.json();
}

async function getPlaylist() {
  const now = Date.now();
  if (cachedPlaylist && (now - cacheTime) < CACHE_TTL) {
    return cachedPlaylist;
  }

  try {
    const musicFiles = await fetchGitHubContent(MUSIC_DIR);
    const lrcFiles = await fetchGitHubContent(LRC_DIR);

    const musicList = Array.isArray(musicFiles) 
      ? musicFiles.filter(f => f.name.endsWith('.mp3')).map(f => f.name)
      : [];
    
    const lrcList = Array.isArray(lrcFiles) 
      ? lrcFiles.filter(f => f.name.endsWith('.lrc')).map(f => f.name)
      : [];

    cachedPlaylist = musicList.map((file, index) => {
      const baseName = file.replace('.mp3', '');
      const lrcName = lrcList.find(l => l.replace('.lrc', '') === baseName);
      const info = parseFilename(file);
      
      return {
        id: index + 1,
        name: file,
        artist: info.artist,
        title: info.title,
        url: `${BASE_URL}${MUSIC_DIR}${encodeURIComponent(file)}`,
        lrc: lrcName ? `${BASE_URL}${LRC_DIR}${encodeURIComponent(lrcName)}` : null
      };
    });

    cacheTime = now;
    return cachedPlaylist;
  } catch (error) {
    console.error('Failed to fetch playlist:', error);
    return cachedPlaylist || [];
  }
}

function parseFilename(filename) {
  const nameWithoutExt = filename.replace(/\.(mp3|lrc)$/i, '');
  let artist = '';
  let title = nameWithoutExt;

  if (nameWithoutExt.includes(' - ')) {
    const parts = nameWithoutExt.split(' - ');
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  }

  return { artist, title, filename };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, '');
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    if (path === 'api' || path === 'api/playlist' || path === '') {
      const playlist = await getPlaylist();

      return new Response(JSON.stringify({
        code: 200,
        message: 'success',
        data: {
          total: playlist.length,
          list: playlist
        }
      }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders()
        }
      });
    }

    if (path === 'api/random') {
      const playlist = await getPlaylist();
      if (playlist.length === 0) {
        return new Response(JSON.stringify({
          code: 404,
          message: 'No music files found',
          data: null
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      const randomItem = playlist[Math.floor(Math.random() * playlist.length)];

      return new Response(JSON.stringify({
        code: 200,
        message: 'success',
        data: randomItem
      }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders()
        }
      });
    }

    if (path === 'api/refresh') {
      cachedPlaylist = null;
      cacheTime = 0;
      const playlist = await getPlaylist();

      return new Response(JSON.stringify({
        code: 200,
        message: 'Playlist refreshed',
        data: {
          total: playlist.length,
          list: playlist
        }
      }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders()
        }
      });
    }

    if (path === 'api/search') {
      const query = url.searchParams.get('q') || '';
      if (!query) {
        return new Response(JSON.stringify({
          code: 400,
          message: '缺少搜索关键词',
          data: null
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      const playlist = await getPlaylist();
      const results = playlist.filter(item => 
        item.title.toLowerCase().includes(query.toLowerCase()) ||
        item.artist.toLowerCase().includes(query.toLowerCase()) ||
        item.name.toLowerCase().includes(query.toLowerCase())
      );

      return new Response(JSON.stringify({
        code: 200,
        message: 'success',
        data: {
          total: results.length,
          query: query,
          list: results
        }
      }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders()
        }
      });
    }

    if (path.startsWith('api/music/')) {
      const filename = decodeURIComponent(path.replace('api/music/', ''));
      const musicUrl = `${BASE_URL}${MUSIC_DIR}${filename}`;
      
      const response = await fetch(musicUrl);
      if (!response.ok) {
        return new Response(JSON.stringify({
          code: 404,
          message: '音乐文件不存在',
          data: null
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      return new Response(response.body, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Disposition': `inline; filename="${filename}"`,
          ...corsHeaders()
        }
      });
    }

    if (path.startsWith('api/lrc/')) {
      const filename = decodeURIComponent(path.replace('api/lrc/', ''));
      const lrcUrl = `${BASE_URL}${LRC_DIR}${filename}`;
      
      const response = await fetch(lrcUrl);
      if (!response.ok) {
        return new Response(JSON.stringify({
          code: 404,
          message: '歌词文件不存在',
          data: null
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      return new Response(response.body, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          ...corsHeaders()
        }
      });
    }

    return new Response(JSON.stringify({
      code: 404,
      message: 'API endpoint not found',
      data: null
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      code: 500,
      message: 'Server error: ' + error.message,
      data: null
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
