const BASE_URL = 'https://classin-music-api.3687448041.workers.dev';

async function testApi() {
    console.log('测试API获取音乐列表...');
    
    try {
        // 测试获取播放列表
        const response = await fetch(`${BASE_URL}/api`);
        const data = await response.json();
        
        console.log('API响应:', JSON.stringify(data, null, 2));
        
        console.log('\n播放列表中的歌曲:');
        data.data.list.forEach((song, index) => {
            console.log(`${index + 1}. ${song.title} - ${song.artist}`);
            console.log(`   音乐文件: ${song.url}`);
            console.log(`   歌词文件: ${song.lrc || '无歌词文件'}`);
            console.log('');
        });
        
        console.log(`总共 ${data.data.total} 首歌曲`);
        
        // 统计有歌词和没有歌词的歌曲数量
        const songsWithLrc = data.data.list.filter(song => song.lrc !== null);
        const songsWithoutLrc = data.data.list.filter(song => song.lrc === null);
        
        console.log(`有歌词的歌曲: ${songsWithLrc.length} 首`);
        console.log(`没有歌词的歌曲: ${songsWithoutLrc.length} 首`);
        
    } catch (error) {
        console.error('测试API时出错:', error);
    }
}

// 运行测试
testApi();