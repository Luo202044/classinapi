# 四季亭音乐 API 文档

## 基础信息

| 项目 | 内容 |
|------|------|
| **Base URL** | `https://classin-music-api.3687448041.workers.dev` |
| **协议** | HTTPS |
| **数据格式** | JSON |
| **跨域支持** | 已启用 CORS |

---

## API 端点

### 1. 获取播放列表

获取所有音乐文件的列表。

```
GET /api/playlist
GET /api
GET /
```

**响应示例：**

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total": 4,
    "list": [
      {
        "id": 1,
        "name": "I Can't Wait (秋绘翻唱).mp3",
        "artist": "",
        "title": "I Can't Wait (秋绘翻唱)",
        "url": "https://raw.githubusercontent.com/Luo202044/classinapi/main/music/I%20Can%27t%20Wait%20(%E7%A7%8B%E7%BB%98%E7%BF%BB%E5%94%B1).mp3",
        "lrc": null
      },
      {
        "id": 2,
        "name": "ナナツカゼ - あのね.mp3",
        "artist": "ナナツカゼ",
        "title": "あのね",
        "url": "https://raw.githubusercontent.com/Luo202044/classinapi/main/music/%E3%83%8A%E3%83%8A%E3%83%84%E3%82%AB%E3%82%BC%20-%20%E3%81%82%E3%81%AE%E3%81%AD.mp3",
        "lrc": null
      }
    ]
  }
}
```

---

### 2. 随机获取一首音乐

从播放列表中随机返回一首音乐。

```
GET /api/random
```

**响应示例：**

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "id": 3,
    "name": "乌托邦P - 反乌托邦.mp3",
    "artist": "乌托邦P",
    "title": "反乌托邦",
    "url": "https://raw.githubusercontent.com/Luo202044/classinapi/main/music/%E4%B9%8C%E6%89%98%E9%82%A6P%20-%20%E5%8F%8D%E4%B9%8C%E6%89%98%E9%82%A6.mp3",
    "lrc": null
  }
}
```

---

### 3. 搜索音乐

根据关键词搜索音乐（支持歌名、艺术家、文件名）。

```
GET /api/search?q={keyword}
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| q | string | 是 | 搜索关键词 |

**响应示例：**

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total": 1,
    "query": "秋绘",
    "list": [
      {
        "id": 1,
        "name": "I Can't Wait (秋绘翻唱).mp3",
        "artist": "",
        "title": "I Can't Wait (秋绘翻唱)",
        "url": "...",
        "lrc": null
      }
    ]
  }
}
```

---

### 4. 刷新播放列表缓存

强制刷新音乐列表缓存（默认缓存 5 分钟）。

```
GET /api/refresh
```

**响应示例：**

```json
{
  "code": 200,
  "message": "Playlist refreshed",
  "data": {
    "total": 4,
    "list": [...]
  }
}
```

---

### 5. 获取音乐文件

直接获取音乐文件流。

```
GET /api/music/{filename}
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| filename | string | 是 | 音乐文件名（需 URL 编码） |

**响应：**
- Content-Type: `audio/mpeg`
- 返回音频文件流

**示例：**
```
GET /api/music/%E3%83%8A%E3%83%8A%E3%83%84%E3%82%AB%E3%82%BC%20-%20%E3%81%82%E3%81%AE%E3%81%AD.mp3
```

---

### 6. 获取歌词文件

直接获取歌词文件内容。

```
GET /api/lrc/{filename}
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| filename | string | 是 | 歌词文件名（需 URL 编码） |

**响应：**
- Content-Type: `text/plain; charset=utf-8`
- 返回 LRC 格式歌词内容

---

## 状态码说明

| 状态码 | 说明 |
|--------|------|
| 200 | 请求成功 |
| 400 | 请求参数错误 |
| 404 | 资源不存在 |
| 500 | 服务器内部错误 |

---

## 数据字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| id | number | 音乐唯一标识 |
| name | string | 原始文件名 |
| artist | string | 艺术家名称（从文件名解析） |
| title | string | 歌曲标题（从文件名解析） |
| url | string | 音乐文件直链（GitHub Raw） |
| lrc | string \| null | 歌词文件直链（无歌词时为 null） |

---

## 使用示例

### JavaScript / Fetch

```javascript
const API_BASE = 'https://classin-music-api.3687448041.workers.dev';

// 获取播放列表
fetch(`${API_BASE}/api/playlist`)
  .then(res => res.json())
  .then(data => console.log(data));

// 搜索音乐
fetch(`${API_BASE}/api/search?q=秋绘`)
  .then(res => res.json())
  .then(data => console.log(data));

// 随机播放
fetch(`${API_BASE}/api/random`)
  .then(res => res.json())
  .then(data => {
    const audio = new Audio(data.data.url);
    audio.play();
  });
```

### HTML Audio 播放器

```html
<audio controls>
  <source src="https://classin-music-api.3687448041.workers.dev/api/music/%E3%83%8A%E3%83%8A%E3%83%84%E3%82%AB%E3%82%BC%20-%20%E3%81%82%E3%81%AE%E3%81%AD.mp3" type="audio/mpeg">
</audio>
```

---

## 注意事项

1. **缓存机制**：播放列表默认缓存 5 分钟，新上传音乐后需调用 `/api/refresh` 刷新
2. **文件名格式**：支持 `艺术家 - 歌曲名.mp3` 格式自动解析艺术家和标题
3. **歌词匹配**：歌词文件需与音乐文件同名（仅扩展名不同，如 `.lrc`）
4. **文件存储**：音乐文件存储在 GitHub 仓库的 `music/` 目录下
