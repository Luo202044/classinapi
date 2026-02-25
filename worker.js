const MUSIC_DIR = 'music/';
const LRC_DIR = 'lrc/';

const MUSIC_FILES = [
  '乌托邦P - 反乌托邦.mp3',
  '铁花飞 - Mili,塞壬唱片-MSR.mp3',
  "I Can't Wait (秋绘翻唱).mp3",
  'ナナツカゼ - あのね.mp3'
];

const LRC_FILES = [
  '乌托邦P - 反乌托邦.lrc',
  '铁花飞 - Mili,塞壬唱片-MSR.lrc',
  "I Can't Wait (秋绘翻唱).lrc",
  'ナナツカゼ - あのね.lrc'
];

const BASE_URL = 'https://raw.githubusercontent.com/Luo202044/classinapi/main/';

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
      const playlist = MUSIC_FILES.map((file, index) => {
        const info = parseFilename(file);
        return {
          id: index + 1,
          name: file,
          artist: info.artist,
          title: info.title,
          url: `${BASE_URL}${MUSIC_DIR}${encodeURIComponent(file)}`,
          lrc: LRC_FILES[index] ? `${BASE_URL}${LRC_DIR}${encodeURIComponent(LRC_FILES[index])}` : null
        };
      });

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
      const randomIndex = Math.floor(Math.random() * MUSIC_FILES.length);
      const file = MUSIC_FILES[randomIndex];
      const info = parseFilename(file);

      return new Response(JSON.stringify({
        code: 200,
        message: 'success',
        data: {
          id: randomIndex + 1,
          name: file,
          artist: info.artist,
          title: info.title,
          url: `${BASE_URL}${MUSIC_DIR}${encodeURIComponent(file)}`,
          lrc: LRC_FILES[randomIndex] ? `${BASE_URL}${LRC_DIR}${encodeURIComponent(LRC_FILES[randomIndex])}` : null
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

      const results = MUSIC_FILES
        .map((file, index) => {
          const info = parseFilename(file);
          return { ...info, index };
        })
        .filter(item => 
          item.title.toLowerCase().includes(query.toLowerCase()) ||
          item.artist.toLowerCase().includes(query.toLowerCase()) ||
          item.name.toLowerCase().includes(query.toLowerCase())
        )
        .map((item, i) => ({
          id: item.index + 1,
          name: item.filename,
          artist: item.artist,
          title: item.title,
          url: `${BASE_URL}${MUSIC_DIR}${encodeURIComponent(item.filename)}`,
          lrc: LRC_FILES[item.index] ? `${BASE_URL}${LRC_DIR}${encodeURIComponent(LRC_FILES[item.index])}` : null
        }));

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
