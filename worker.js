const MUSIC_DIR = 'music/';
const LRC_DIR = 'lrc/';
const GITHUB_API = 'https://cdn.jsdmirror.com/gh/Luo202044/classinapi@f3be701dea515ab152253468e27b35855a851d4f/';

let cachedPlaylist = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

// 扫描仓库根目录以获取音乐和歌词文件的完整列表
async function scanRepoRoot() {
  try {
    console.log('Scanning repository root for music and lrc directories...');
    const response = await fetch(`${GITHUB_API}`, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Cloudflare-Worker'
      }
    });
    
    if (!response.ok) {
      console.error(`Failed to scan repo root: ${response.status} ${response.statusText}`);
      return { musicFiles: [], lrcFiles: [] };
    }
    
    const repoContents = await response.json();
    
    // 查找music和lrc目录
    const musicDir = repoContents.find(item => item.type === 'dir' && item.name === 'music');
    const lrcDir = repoContents.find(item => item.type === 'dir' && item.name === 'lrc');
    
    let musicFiles = [];
    let lrcFiles = [];
    
    if (musicDir) {
      const musicResponse = await fetch(musicDir.url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Cloudflare-Worker'
        }
      });
      if (musicResponse.ok) {
        const musicContent = await musicResponse.json();
        musicFiles = musicContent.filter(item => item.type === 'file' && item.name.endsWith('.mp3'));
      }
    }
    
    if (lrcDir) {
      const lrcResponse = await fetch(lrcDir.url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Cloudflare-Worker'
        }
      });
      if (lrcResponse.ok) {
        const lrcContent = await lrcResponse.json();
        lrcFiles = lrcContent.filter(item => item.type === 'file' && item.name.endsWith('.lrc'));
      }
    }
    
    console.log(`Found ${musicFiles.length} music files and ${lrcFiles.length} lrc files from repo scan`);
    return { musicFiles, lrcFiles };
  } catch (error) {
    console.error('Error scanning repo root:', error);
    return { musicFiles: [], lrcFiles: [] };
  }
}

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
  
  console.error(`GitHub API error: ${response.status} ${response.statusText}. Trying alternative methods...`);
  
  // 尝试扫描仓库根目录作为备用方法
  const scanResult = await scanRepoRoot();
  if (path === MUSIC_DIR) {
    return scanResult.musicFiles;
  } else if (path === LRC_DIR) {
    return scanResult.lrcFiles;
  }
  
  // 如果扫描仓库也失败，尝试使用jsDelivr作为备用方案
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
    
    // 根据路径类型处理文件
    let resultFiles = [];
    
    if (path === MUSIC_DIR) {
      // 为音乐目录创建.mp3文件
      resultFiles = lines.map(line => {
        let filename = line.trim();
        // 如果行以数字开头（如"1乌托邦P-反乌托邦"），去除开头的数字
        filename = filename.replace(/^\d+/, '');
        // 确保文件名以.mp3结尾
        if (!filename.toLowerCase().endsWith('.mp3')) {
          filename += '.mp3';
        }
        return {
          name: filename,
          path: `${MUSIC_DIR}${filename}`,
          sha: '',  // 空值，因为我们不使用这个字段
          size: 0,  // 空值，因为我们不使用这个字段
          url: '',  // 空值，因为我们不使用这个字段
          html_url: '',  // 空值，因为我们不使用这个字段
          git_url: '',  // 空值，因为我们不使用这个字段
          download_url: '',  // 空值，因为我们不使用这个字段
          type: 'file'
        };
      });
    } else if (path === LRC_DIR) {
      // 为歌词目录创建.lrc文件
      resultFiles = lines.map(line => {
        let filename = line.trim();
        // 如果行以数字开头，去除开头的数字
        filename = filename.replace(/^\d+/, '');
        // 将.mp3替换为.lrc
        if (filename.toLowerCase().endsWith('.mp3')) {
          filename = filename.substring(0, filename.length - 4) + '.lrc';
        } else {
          filename += '.lrc';
        }
        return {
          name: filename,
          path: `${LRC_DIR}${filename}`,
          sha: '',  // 空值，因为我们不使用这个字段
          size: 0,  // 空值，因为我们不使用这个字段
          url: '',  // 空值，因为我们不使用这个字段
          html_url: '',  // 空值，因为我们不使用这个字段
          git_url: '',  // 空值，因为我们不使用这个字段
          download_url: '',  // 空值，我们认为不使用这个字段
          type: 'file'
        };
      });
    }
    
    console.log(`Retrieved ${resultFiles.length} files from static api.txt for path: ${path}`);
    return resultFiles;
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
    // 尝试从GitHub API获取文件列表
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
      
      // 如果所有方法都失败，最后尝试从api.txt直接生成播放列表
      console.log('All methods failed, trying to generate playlist from api.txt directly...');
      try {
        const apiTxtResponse = await fetch('https://raw.githubusercontent.com/Luo202044/classinapi/main/api.txt');
        if (apiTxtResponse.ok) {
          const apiTxtContent = await apiTxtResponse.text();
          const lines = apiTxtContent.split('\n').filter(line => line.trim() !== '');
          
          if (lines.length > 0) {
            console.log(`Generated playlist from api.txt with ${lines.length} entries`);
            cachedPlaylist = lines.map((line, index) => {
              let filename = line.trim();
              // 移除开头的数字
              filename = filename.replace(/^\d+/, '');
              
              // 根据api.txt中的格式生成正确的文件名
              // 如果文件名包含 "-" 但不是 " - " 格式，将其转换为带空格的格式（匹配实际文件名）
              if (filename.includes('-') && !filename.includes(' - ')) {
                if (filename.includes('乌托邦P-反乌托邦')) {
                  filename = '乌托邦P - 反乌托邦';
                } else if (filename.includes('ナナツカゼ-あのね')) {
                  filename = 'ナナツカゼ - あのね';
                } else if (filename.includes('铁花飞-Mili,塞壬唱片-MSR')) {
                  filename = '铁花飞-Mili,塞壬唱片-MSR';
                }
              }
              
              // 确保以.mp3结尾
              if (!filename.toLowerCase().endsWith('.mp3')) {
                filename += '.mp3';
              }
              
              const fileName = filename;
              const info = parseFilename(fileName);
              
              // 检查是否存在对应的歌词文件
              let lrcResult = null;
              const baseName = fileName.replace('.mp3', '');
              const hasLrcFile = ['乌托邦P - 反乌托邦.mp3', 'ナナツカゼ - あのね.mp3'].includes(fileName);
              if (hasLrcFile) {
                const lrcFileName = baseName + '.lrc';
                lrcResult = `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${LRC_DIR}${encodeURIComponent(lrcFileName)}`;
              }
              
              return {
                id: index + 1,
                name: fileName,
                artist: info.artist,
                title: info.title,
                url: `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${MUSIC_DIR}${encodeURIComponent(fileName)}`,
                lrc: lrcResult
              };
            });
            
            cacheTime = now;
            return cachedPlaylist;
          }
        }
      } catch (e) {
        console.error('Failed to generate playlist from api.txt:', e);
      }
      
      // 即使所有方法都失败，也尝试从当前目录的文件结构生成播放列表
      console.log('Trying to generate fallback playlist from known file structure...');
      const knownMusicFiles = [
        '铁花飞-Mili,塞壬唱片-MSR.mp3',
        '乌托邦P - 反乌托邦.mp3',
        'I Can\'t Wait (秋绘翻唱).mp3',
        'ナナツカゼ - あのね.mp3'
      ];
      
      cachedPlaylist = knownMusicFiles.map((fileName, index) => {
        const info = parseFilename(fileName);
        const baseName = fileName.replace('.mp3', '');
        
        // 检查是否存在对应的歌词文件
        let lrcResult = null;
        const hasLrcFile = ['乌托邦P - 反乌托邦.mp3', 'ナナツカゼ - あのね.mp3'].includes(fileName);
        if (hasLrcFile) {
          const lrcFileName = baseName + '.lrc';
          lrcResult = `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${LRC_DIR}${encodeURIComponent(lrcFileName)}`;
        }
        
        return {
          id: index + 1,
          name: fileName,
          artist: info.artist,
          title: info.title,
          url: `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${MUSIC_DIR}${encodeURIComponent(fileName)}`,
          lrc: lrcResult
        };
      });
      
      cacheTime = now;
      return cachedPlaylist;
    }

    cachedPlaylist = musicList.map((file, index) => {
      // 确保文件名不包含路径部分
      const fileName = file.split('/').pop().split('\\').pop();
      const baseName = fileName.replace('.mp3', '');
      
      // 查找匹配的歌词文件，确保也处理路径
      let lrcResult = null;
      const matchingLrc = lrcList.find(l => {
        const lrcFileName = l.name.split('/').pop().split('\\').pop();
        return lrcFileName.replace('.lrc', '') === baseName;
      });
      
      if (matchingLrc) {
        const lrcFileName = matchingLrc.name.split('/').pop().split('\\').pop();
        lrcResult = `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${LRC_DIR}${encodeURIComponent(lrcFileName)}`;
      }
      
      const info = parseFilename(fileName);
      
      return {
        id: index + 1,
        name: fileName,  // 使用去除路径的文件名
        artist: info.artist,
        title: info.title,
        // 使用环境变量 BASE_URL，如果未定义则回退到硬编码地址
        url: `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${MUSIC_DIR}${encodeURIComponent(fileName)}`,
        lrc: lrcResult  // 可能为null，如果没有找到匹配的歌词文件
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
    
    // 在异常情况下也尝试从api.txt生成播放列表
    try {
      const apiTxtResponse = await fetch('https://raw.githubusercontent.com/Luo202044/classinapi/main/api.txt');
      if (apiTxtResponse.ok) {
        const apiTxtContent = await apiTxtResponse.text();
        const lines = apiTxtContent.split('\n').filter(line => line.trim() !== '');
        
        if (lines.length > 0) {
          console.log(`Generated playlist from api.txt in error handler with ${lines.length} entries`);
          const fallbackPlaylist = lines.map((line, index) => {
            let filename = line.trim();
            // 移除开头的数字
            filename = filename.replace(/^\d+/, '');
            // 确保以.mp3结尾
            if (!filename.toLowerCase().endsWith('.mp3')) {
              filename += '.mp3';
            }
            
            const fileName = filename;
            const info = parseFilename(fileName);
            
            return {
              id: index + 1,
              name: fileName,
              artist: info.artist,
              title: info.title,
              url: `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${MUSIC_DIR}${encodeURIComponent(fileName)}`,
              lrc: null  // 异常情况下先设置为null
            };
          });
          
          return fallbackPlaylist;
        }
      }
    } catch (e) {
      console.error('Failed to generate fallback playlist from api.txt:', e);
    }
    
    // 如果所有方法都失败，返回已知的文件列表作为最后的备选方案
    console.log('Using fallback playlist with known files...');
    const fallbackPlaylist = [
      {
        id: 1,
        name: '铁花飞-Mili,塞壬唱片-MSR.mp3',
        artist: 'Mili,塞壬唱片-MSR',
        title: '铁花飞',
        url: `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${MUSIC_DIR}${encodeURIComponent('铁花飞-Mili,塞壬唱片-MSR.mp3')}`,
        lrc: null  // 此音乐没有歌词文件
      },
      {
        id: 2,
        name: '乌托邦P - 反乌托邦.mp3',
        artist: '乌托邦P',
        title: '反乌托邦',
        url: `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${MUSIC_DIR}${encodeURIComponent('乌托邦P - 反乌托邦.mp3')}`,
        lrc: `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${LRC_DIR}${encodeURIComponent('乌托邦P - 反乌托邦.lrc')}`  // 此音乐有歌词文件
      },
      {
        id: 3,
        name: 'I Can\'t Wait (秋绘翻唱).mp3',
        artist: '秋绘',
        title: 'I Can\'t Wait (翻唱)',
        url: `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${MUSIC_DIR}${encodeURIComponent('I Can\'t Wait (秋绘翻唱).mp3')}`,
        lrc: null  // 此音乐没有歌词文件
      },
      {
        id: 4,
        name: 'ナナツカゼ - あのね.mp3',
        artist: 'ナナツカゼ',
        title: 'あのね',
        url: `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${MUSIC_DIR}${encodeURIComponent('ナナツカゼ - あのね.mp3')}`,
        lrc: `${env.BASE_URL || 'https://raw.githubusercontent.com/Luo202044/classinapi/main/'}${LRC_DIR}${encodeURIComponent('ナナツカゼ - あのね.lrc')}`  // 此音乐有歌词文件
      }
    ];
    
    return fallbackPlaylist;
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
  } else if (nameWithoutExt.includes('-')) {
    // 如果没有空格分隔的 " - "，尝试使用简单的 "-" 分隔符
    const parts = nameWithoutExt.split('-');
    if (parts.length >= 2) {
      artist = parts[0].trim();
      title = parts.slice(1).join('-').trim();
    }
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
        
        // 将文件名转换为api.txt格式（如果没有空格的" - "分隔符，移除空格）
        if (fileNameWithoutExt.includes(' - ')) {
          fileNameWithoutExt = fileNameWithoutExt.replace(' - ', '-');
        }
        
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
      
      try {
        const response = await fetch(lrcUrl);
        if (!response.ok) {
          // 如果歌词文件不存在，返回空的歌词内容而不是404错误
          console.log(`Lyric file not found: ${cleanFilename}, returning empty content`);
          return new Response('', {
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              ...corsHeaders()
            }
          });
        }

        return new Response(response.body, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            ...corsHeaders()
          }
        });
      } catch (error) {
        console.error(`Error fetching lyric file: ${error}`);
        // 发生错误时也返回空内容而不是错误
        return new Response('', {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            ...corsHeaders()
          }
        });
      }
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
