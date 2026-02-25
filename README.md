# 四季亭 音乐API

## 新版 API (Cloudflare Workers 部署)
## api url
```
api1(国内推荐 ):https://api.xn--bgtt50a8xt.cn/
api2:https://classin-music-api.3687448041.workers.dev/

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

---

## 旧版 API (静态托管 - 不推荐)

## 1. 概述

本文档定义了音乐播放器的后端API接口规范。

### 1.1 api基础URL
```
api1：https://classinapi.pages.dev/
api2：https://luo202044.github.io/cl/
```

### 1.2 支持的音频格式
- MP3

## 2. API端点

### 2.1 获取播放列表 (获取音乐列表)

**请求方式:** `GET`

**端点:** `/api.txt`

**描述:** 获取服务器上的音乐文件列表，返回文本格式的音乐列表

**请求参数:** 无

**请求示例:**
```
GET /api.txt HTTP/1.1
Host: luo202044.github.io
Cache-Control: no-cache
```

**响应示例:**
```
HTTP/1.1 200 OK
Content-Type: text/plain

1乌托邦P-反乌托邦.mp3
铁花飞-Mili,塞壬唱片-MSR.mp3
I Can't Wait (秋绘翻唱).mp3
1ナナツカゼ-あのね.mp3
```

**错误响应:**
- `404 Not Found`: 文件不存在
- `500 Internal Server Error`: 服务器内部错误

### 2.2 获取音乐文件

**请求方式:** `GET`

**端点:** `/{filename}`

**描述:** 获取指定的音乐文件

**路径参数:**
- `filename` (string, required): 音乐文件名，需要URL编码

**请求示例:**
```
GET /%E4%B9%8C%E6%89%98%E9%82%A6P-%E5%8F%8D%E4%B9%8C%E6%89%98%E9%82%A6.mp3 HTTP/1.1
Host: luo202044.github.io
```

**响应:** 音频文件流

**错误响应:**
- `404 Not Found`: 音乐文件不存在
- `403 Forbidden`: 无权限访问

### 2.3 播放控制接口

不支持


## 4. 错误码

| 错误码 | 描述 | 解决方案 |
|--------|------|----------|
| 400 | 请求参数错误 | 检查请求参数格式 |
| 404 | 资源不存在 | 确认请求的资源路径 |
| 500 | 服务器内部错误 | 联系管理员 |
| ERROR_FETCH_PLAYLIST | 播放列表获取失败 | 检查网络连接 |

## 5. 客户端实现说明
- 由于api是静态，需要手动解析
```
classinapi/
├── README.md          # 项目说明文件
├── api.txt           # API接口定义
├── lrc/              # 歌词文件目录
│   └── 0             # 占位符
├── music/            # 音乐文件目录
│   ├── 0             # 占位符
│   ├── xxxx.mp3
│   ├── xxxx.mp3
│   ├── xxxx.mp3
│   └── xxxx.mp3

```
你需要在解析结果加music（音乐）和lrc（字幕）路径
如
```
api.txt获取xxxx(音乐）
解析音乐：https://classinapi.pages.dev/music/xxxx.mp3
解析字幕：https://classinapi.pages.dev/lrc/xxxx.lrc
```
### 5.1 文件名处理
- 从文件名中提取艺术家和标题信息
- 使用正则表达式处理特殊字符和格式
- 支持 "艺术家 - 标题" 格式的文件名解析
