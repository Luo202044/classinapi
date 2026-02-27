const MUSIC_DIR = 'music/';
const LRC_DIR = 'lrc/';
const GITHUB_API = 'https://api.github.com/repos/Luo202044/classinapi/contents';

let cachedPlaylist = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchGitHubContent(path) {
  // 首先尝试GitHub API
  const response = await fetch(`${GITHUB_API}/${path}`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Cloudflare-Worker'
    }
  });
  if (response.ok) {
    return await response.json();
  }
  
  console.error(`GitHub API error: ${response.status} ${response.statusText}. Trying jsDelivr as fallback...`);
  
  // 如果GitHub API失败，尝试使用jsDelivr作为备用方案
  try {
    // 构建jsDelivr目录URL
    const jsDelivrDirUrl = `https://cdn.jsdelivr.net/gh/Luo202044/classinapi@main/${path}`;
    const dirResponse = await fetch(jsDelivrDirUrl);
    
    if (!dirResponse.ok) {
      console.error(`jsDelivr directory access failed: ${dirResponse.status} ${dirResponse.statusText}`);
      // 如果jsDelivr也失败，尝试从静态api.txt文件推断文件列表
      return await fetchFromStaticApiTxt(path);
    }
    
    const html = await dirResponse.text();
    
    // 从HTML中解析文件列表，匹配包含文件名的链接
    // jsDelivr目录页面的链接可能有多种形式，如 <a href="filename.mp3"> 或 <a href="./filename.mp3"> 或完整URL
    const fileRegex = /<a[^>]*href\s*=\s*["'][^"']*(?:\/|^)([^"']*?\.(mp3|lrc))["'][^>]*>/gi;
    const matches = [...html.matchAll(fileRegex)];
    
    // 创建模拟GitHub API响应格式的文件对象数组
    const files = matches.map(match => ({
      name: match[1],
      path: `${path}${match[1]}`,
      sha: '',  // 空值，因为我们不使用这个字段
      size: 0,  // 空值，因为我们不使用这个字段
      url: '',  // 空值，因为我们不使用这个字段
      html_url: '',  // 空值，因为我们不使用这个字段
      git_url: '',  // 空值，因为我们不使用这个字段
      download_url: '',  // 空值，因为我们不使用这个字段
      type: 'file'
    }));
    
    // 去重并返回
    const uniqueFiles = files.filter((file, index, self) => 
      index === self.findIndex(f => f.name === file.name)
    );
    
    console.log(`Retrieved ${uniqueFiles.length} files from jsDelivr for path: ${path}`);
    return uniqueFiles;
  } catch (error) {
    console.error(`Fallback to jsDelivr also failed:`, error);
    // 如果jsDelivr也失败，尝试从静态api.txt文件推断文件列表
    return await fetchFromStaticApiTxt(path);
  }
}

// 从静态api.txt文件推断文件列表的备用函数
async function fetchFromStaticApiTxt(path) {
  try {
    console.log(`Trying to fetch from static api.txt as last resort for path: ${path}`);
    
    // 获取静态api.txt文件内容
    const apiTxtResponse = await fetch('https://raw.githubusercontent.com/Luo202044/classinapi/main/api.txt');
    if (!apiTxtResponse.ok) {
      console.error('Failed to fetch static api.txt file');
      return [];
    }
    
    const apiTxtContent = await apiTxtResponse.text();
    const lines = apiTxtContent.split('\n').filter(line => line.trim() !== '');
    
    // 根据路径类型过滤文件
    let fileExtensions;
    if (path === MUSIC_DIR) {
      fileExtensions = ['.mp3'];
    } else if (path === LRC_DIR) {
      fileExtensions = ['.lrc'];
    } else {
      fileExtensions = ['.mp3', '.lrc']; // 默认支持两种类型
    }
    
    // 根据路径过滤相应的文件
    const files = lines
      .filter(line => {
        const filename = line.trim();
        return fileExtensions.some(ext => filename.toLowerCase().includes(ext) || filename.replace(/.*-/, '').toLowerCase().includes(ext));
      })
      .map(filename => {
        // 确定文件类型
        const lowerFilename = filename.toLowerCase();
        let ext = '.mp3'; // 默认为mp3
        if (lowerFilename.includes('.lrc')) ext = '.lrc';
        
        // 确保文件名有扩展名
        const finalFilename = ext === '.mp3' && !lowerFilename.endsWith('.mp3') 
          ? filename + '.mp3' 
          : filename;
        
        return {
          name: finalFilename,
          path: `${path}${finalFilename}`,
          sha: '',  // 空值，因为我们不使用这个字段
          size: 0,  // 空值，因为我们不使用这个字段
          url: '',  // 空值，因为我们不使用这个字段
          html_url: '',  // 空值，因为我们不使用这个字段
          git_url: '',  // 空值，因为我们不使用这个字段
          download_url: '',  // 空值，因为我们不使用这个字段
          type: 'file'
        };
      });
    
    console.log(`Retrieved ${files.length} files from static api.txt for path: ${path}`);
    return files;
  } catch (error) {
    console.error('Failed to fetch from static api.txt:', error);
    return [];
  }
}

async function getPlaylist(env) {
  const now = Date.now();
  if (cachedPlaylist && (now - cacheTime) < CACHE_TTL) {
    return cachedPlaylist;
  }

  try {
    const musicFiles = await fetchGitHubContent(MUSIC_DIR);
    const lrcFiles = await fetchGitHubContent(LRC_DIR);

    // 检查是否获取到了有效的文件列表
    if (!Array.isArray(musicFiles) || musicFiles.length === 0) {
      console.warn('No music files retrieved, using cached playlist if available');
      if (cachedPlaylist) {
        // 更新缓存时间，避免频繁重试
        cacheTime = now;
        return cachedPlaylist;
      }
    }

    const musicList = Array.isArray(musicFiles) 
      ? musicFiles.filter(f => f.name.endsWith('.mp3')).map(f => f.name)
      : [];
    
    const lrcList = Array.isArray(lrcFiles) 
      ? lrcFiles.filter(f => f.name.endsWith('.lrc')).map(f => f.name)
      : [];

    if (musicList.length === 0) {
      console.warn('No music files found, using cached playlist if available');
      if (cachedPlaylist) {
        // 更新缓存时间，避免频繁重试
        cacheTime = now;
        return cachedPlaylist;
      }
      return []; // 如果没有缓存且获取失败，则返回空列表
    }

    cachedPlaylist = musicList.map((file, index) => {
      // 确保文件名不包含路径部分
      const fileName = file.split('/').pop().split('\\').pop();
      const baseName = fileName.replace('.mp3', '');
      const lrcName = lrcList.find(l => {
        const lrcFileName = l.name.split('/').pop().split('\\').pop();
        return lrcFileName.replace('.lrc', '') === baseName;
      });
      const info = parseFilename(fileName);
      
      return {
        id: index + 1,
        name: fileName,  // 使用去除路径的文件名
        artist: info.artist,
        title: info.title,
        // 使用环境变量 BASE_URL，如果未定义则回退到硬编码地址
        url: `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${MUSIC_DIR}${encodeURIComponent(fileName)}`,
        lrc: lrcName ? `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${LRC_DIR}${encodeURIComponent(lrcName.split('/').pop().split('\\').pop())}` : null
      };
    });

    cacheTime = now;
    return cachedPlaylist;
  } catch (error) {
    console.error('Failed to fetch playlist:', error);
    // 如果当前有缓存数据，返回缓存数据而不是空列表
    if (cachedPlaylist) {
      console.log('Using cached playlist due to error');
      // 更新缓存时间，避免频繁重试
      cacheTime = now;
      return cachedPlaylist;
    }
    return [];
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

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, '');
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    // 添加对 /api.txt 端点的支持，返回文本格式的音乐列表
    if (path === 'api.txt') {
      const playlist = await getPlaylist(env);
      
      // 将音乐列表转换为文本格式，与原始 api.txt 格式相似
      const textList = playlist.map(item => {
        // 提取不含扩展名的文件名，并确保去除路径部分
        let fileNameWithoutExt = item.name.replace('.mp3', '');
        // 如果文件名包含路径分隔符，只取最后部分
        fileNameWithoutExt = fileNameWithoutExt.split('/').pop().split('\\').pop();
        return fileNameWithoutExt;
      }).join('\n');
      
      return new Response(textList, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          ...corsHeaders()
        }
      });
    }
    
    if (path === 'api' || path === 'api/playlist' || path === '') {
      const playlist = await getPlaylist(env);

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
      const playlist = await getPlaylist(env);
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
      const playlist = await getPlaylist(env);

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

      const playlist = await getPlaylist(env);
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
      // 确保文件名不包含路径遍历
      const cleanFilename = filename.split('/').pop().split('\\').pop();
      const musicUrl = `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${MUSIC_DIR}${cleanFilename}`;
      
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
          'Content-Disposition': `inline; filename="${cleanFilename}"`,
          ...corsHeaders()
        }
      });
    }

    if (path.startsWith('api/lrc/')) {
      const filename = decodeURIComponent(path.replace('api/lrc/', ''));
      // 确保文件名不包含路径遍历
      const cleanFilename = filename.split('/').pop().split('\\').pop();
      const lrcUrl = `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${LRC_DIR}${cleanFilename}`;
      
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

// ES Modules 入口
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};