# 四季亭 音乐 API（Cloudflare Workers 版）

## 简介

基于 Cloudflare Workers 构建的音乐 API 服务，支持动态配置、持久化缓存、速率限制和管理端点。可从远程仓库（GitHub / CDN）读取歌曲列表，并提供音乐和歌词的代理访问。

## 在线实例

| 节点 | 地址 |
|------|------|
| 国内推荐 | `https://api.xn--bgtt50a8xt.cn/` |
| 备用节点 | `https://classin-music-api.3687448041.workers.dev/` |

---

## 功能特性

- ✅ 从远程 `api.txt` 自动同步歌曲列表  
- ✅ JSON / 纯文本 两种播放列表格式  
- ✅ 随机歌曲、关键词搜索  
- ✅ 音乐文件（mp3）和歌词（lrc）代理  
- ✅ 多级缓存（内存 + D1 数据库）  
- ✅ 动态配置（通过 KV 修改音乐源，无需重新部署）  
- ✅ 内置速率限制（10秒 50次 / IP）  
- ✅ 管理端点（刷新配置/音乐缓存，需 token 验证）  
- ✅ 全 CORS 支持

---

## API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/` 或 `/api` 或 `/api/playlist` | GET | 获取 JSON 格式播放列表 |
| `/api.txt` | GET | 获取纯文本播放列表（每行格式：`艺术家-歌曲名`） |
| `/api/random` | GET | 随机返回一首歌曲 |
| `/api/search?q=关键词` | GET | 按标题、艺术家、文件名搜索 |
| `/api/music/{文件名}.mp3` | GET | 代理获取音乐文件（需 URL 编码） |
| `/api/lrc/{文件名}.lrc` | GET | 代理获取歌词文件（不存在返回空） |
| `/api/update` | GET | 手动从源拉取并更新缓存（不检查过期） |
| `/api/refresh` | GET | 强制刷新缓存（清除内存和 D1 后重新拉取） |
| `/api/ser/reload?token=xxx` | GET | 重新加载配置（清除配置缓存和音乐缓存） |
| `/api/ser/meload?token=xxx` | GET | 仅重新加载音乐缓存（清除后重新拉取） |

---

### 响应示例（/api）

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total": 19,
    "list": [
      {
        "id": 1,
        "name": "乌托邦P - 反乌托邦.mp3",
        "artist": "乌托邦P",
        "title": "反乌托邦",
        "url": "https://.../music/乌托邦P%20-%20反乌托邦.mp3",
        "lrc": "https://.../lrc/乌托邦P%20-%20反乌托邦.lrc"
      }
    ]
  }
}
```
---

## 管理功能

管理端点需要携带 `token` 参数，token 从 KV 的 `config_token` 读取，若未设置则使用默认值 `1234567890`。

- **重新加载配置**（清除配置缓存 + 音乐缓存）  
  `GET /api/ser/reload?token=1234567890`  
  适用于修改 `base_url` 后立即生效。

- **仅重新加载音乐缓存**  
  `GET /api/ser/meload?token=1234567890`  
  当源 `api.txt` 更新后，强制刷新播放列表。

---

## 速率限制

- **规则**：每个 IP 在 10 秒内最多 50 次请求（所有端点）。
- **超限响应**：HTTP 429，响应体为 `{"code":429,"message":"Too Many Requests","data":null}`。
- **实现**：基于 Cloudflare 内置 Rate Limiting API，边缘节点独立计数，性能极高。
- **调整**：如需修改限制，更改 `wrangler.toml` 中 `rate_limits` 的 `limit` 和 `period` 后重新部署。

---

## 缓存机制

| 缓存层 | 存储位置 | 过期时间 | 说明 |
|--------|----------|----------|------|
| 内存 | Worker 实例 | 30 天 | 每 7 天自动检查源更新（内容不变仅更新时间戳） |
| D1 | Cloudflare D1 | 30 天 | 跨实例共享，作为持久化后备 |
| 配置 | 内存 + KV | 5 分钟 | `base_url` 缓存，减少 KV 读取 |

当源内容变化时，调用 `/api/refresh` 或 `/api/ser/meload` 可立即更新所有缓存。

---

## 故障排查

### 1. 播放列表数量不符

- 访问 `/api` 查看返回的 `total` 字段。
- 对比源 `api.txt` 的实际行数。
- 执行 D1 查询确认存储的数组长度：
  ```sql
  SELECT json_array_length(value) FROM cache WHERE key='playlist';
  ```
- 若数量不对，调用 `/api/refresh` 强制刷新。

### 2. 修改 `base_url` 后未生效

- 确保已调用 `/api/ser/reload?token=xxx` 清除配置缓存。
- 检查 KV 中 `base_url` 值是否正确：
  ```bash
  wrangler kv:key get --binding=CONFIG_KV base_url
  ```

### 3. 速率限制误封

- 查看 Worker 日志中 `Rate limit exceeded` 条目。
- 若多个用户共享同一 IP，可适当提高 `limit` 或改为基于用户 ID 限流（需修改代码中的 `key` 参数）。

### 4. D1 写入失败

- 检查 Worker 日志中 `Failed to save to D1` 错误。
- 确认 D1 绑定正确，且未超出免费额度（5GB 存储，每月 5 百万读/写）。

---

