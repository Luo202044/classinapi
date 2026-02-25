# 四季亭 简易音乐API

## 新版 API (Cloudflare Workers 部署)
## api url
```
api1(国内推荐 ):https://api.xn--bgtt50a8xt.cn/
api2:https://classin-music-api.3687448041.workers.dev/
```
### 部署方式

```
#bash
npm install -g wrangler
wrangler login
# 修改 wrangler.toml 中的 BASE_URL
wrangler deploy
```

### API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api` | GET | 获取播放列表 |
| `/api/random` | GET | 随机推荐 |
| `/api/search?q=关键词` | GET | 搜索音乐 |
| `/api/music/文件名.mp3` | GET | 获取音乐文件 |
| `/api/lrc/文件名.lrc` | GET | 获取歌词 |

### 响应示例

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total": 4,
    "list": [
      {
        "id": 1,
        "name": "乌托邦P - 反乌托邦.mp3",
        "artist": "乌托邦P",
        "title": "反乌托邦",
        "url": "https://...",
        "lrc": "https://..."
      }
    ]
  }
}
```

### 解析出对应文件
如果你在看响应内容你会看见这个
```
        "url": "https://...",
        "lrc": "https://..."
```
这里的url就是音乐文件 
lrc即字幕文件 
