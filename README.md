
# 四季亭 音乐 API（Cloudflare Workers 版）

## 简介

基于 Cloudflare Workers 构建的音乐 API 服务，支持动态配置、持久化缓存、速率限制和管理端点。可从远程仓库（GitHub / CDN）读取歌曲列表，并提供音乐和歌词的代理访问。

## 在线实例

| 节点 | 地址 |
|---|---|
| 国内推荐 | `https://api.xn--bgtt50a8xt.top/` |
| 备用节点 | `https://classin-music-api.3687448041.workers.dev/` |

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
- ✅ **用户反馈系统**（提交与查询，支持 D1 持久化）

## API 端点

| 端点 | 方法 | 描述 |
|---|---|---|
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
| `/api/suppost/add` | POST | 提交新反馈（公开接口，无需 token） |
| `/api/suppost/list/get?token=xxx&page=1&limit=20` | GET | 获取反馈列表（需 `suppost_tokens` 校验，支持分页） |
| `/api/suppost/list/del?id=xxx&token=xxx` | GET | 删除指定反馈（需 `suppost_tokens` 校验） |

### 反馈系统说明

- **反馈表（suppose）结构**：`id`、`user_id`、`title`、`main`、`user_ua`、`time`。
- **数据校验**：提交时会对 `title`（1-100 字符）和 `main`（1-350 字符）进行长度校验。
- **分页查询**：默认可通过 `page` 和 `limit` 参数进行分页，数据按 `time` 降序返回。

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

## 管理功能

管理端点需要携带 `token` 参数。

- **重新加载配置（清除配置缓存 + 音乐缓存）**  
  `GET /api/ser/reload?token=1234567890`  
  适用于修改 `base_url` 后立即生效。
- **仅重新加载音乐缓存**  
  `GET /api/ser/meload?token=1234567890`  
  当源 `api.txt` 更新后，强制刷新播放列表。

## 速率限制

- **规则**：每个 IP 在 10 秒内最多 50 次请求（所有端点）。
- **超限响应**：HTTP 429，响应体为 `{"code":429,"message":"Too Many Requests","data":null}`。
- **实现**：基于 Cloudflare 内置 Rate Limiting API，边缘节点独立计数，性能极高。
- **调整**：如需修改限制，更改 `wrangler.toml` 中 `rate_limits` 的 `limit` 和 `period` 后重新部署。

## 缓存机制

| 缓存层 | 存储位置 | 过期时间 | 说明 |
|---|---|---|---|
| 内存 | Worker 实例 | 30 天 | 每 7 天自动检查源更新（内容不变仅更新时间戳） |
| D1 | Cloudflare D1 | 30 天 | 跨实例共享，作为持久化后备 |
| 配置 | 内存 + KV | 5 分钟 | `base_url` 缓存，减少 KV 读取 |

当源内容变化时，调用 `/api/refresh` 或 `/api/ser/meload` 可立即更新所有缓存。

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

- 明白，需要进一步补充 README 中关于反馈系统的说明，特别是请求/响应示例、错误处理、token 配置等细节。以下是**补充后的完整 README 片段**（可直接追加到现有 README 中或替换原“反馈系统”章节）。

---

## 反馈系统 API 详解

### 1. 提交反馈（公开）

**端点**：`POST /api/suppost/add`  
**无需 token**，任何人可提交。

**请求体**（JSON）：
```json
{
  "user_id": "用户名或昵称",
  "title": "反馈标题",
  "main": "反馈内容，支持换行，最多350字",
  "user_ua": "可选，自定义 User-Agent（留空则自动获取）"
}
```

**字段校验**：
| 字段 | 必填 | 长度限制 |
|------|------|----------|
| `user_id` | 是 | ≤50 字符 |
| `title` | 是 | 1–100 字符 |
| `main` | 是 | 1–350 字符（保留换行） |
| `user_ua` | 否 | ≤500 字符，不传则取请求头的 `User-Agent` |

**响应示例（成功）**：
```json
{
  "code": 200,
  "message": "反馈提交成功",
  "data": { "id": 123 }
}
```

**错误响应**：
```json
// 缺少必填字段
{ "code": 400, "message": "缺少必填字段: user_id", "data": null }

// 内容超长
{ "code": 400, "message": "main 内容不能超过350字符", "data": null }

// 数据库错误
{ "code": 500, "message": "提交失败，请稍后重试", "data": null }
```

---

### 2. 获取反馈列表（需 token）

**端点**：`GET /api/suppost/list/get?token=xxx&page=1&limit=20`  
**权限**：需携带 `token`，并在 KV 的 `suppost_tokens` 中配置（逗号分隔）。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `token` | string | 是 | 访问令牌 |
| `page` | int | 否 | 页码，默认 1 |
| `limit` | int | 否 | 每页条数，默认 20，最大 100 |

**响应示例**：
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "list": [
      {
        "id": 10,
        "user_id": "张三",
        "title": "建议增加夜间模式",
        "main": "希望播放器有深色主题",
        "user_ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "time": 1747651200
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 105,
      "total_pages": 6
    }
  }
}
```

**错误响应**：
```json
// token 无效或缺失
{ "code": 502, "message": "Bad Gateway", "data": null }

// 数据库不可用
{ "code": 500, "message": "Database not available", "data": null }
```

---

### 3. 删除反馈（需 token）

**端点**：`GET /api/suppost/list/del?id=123&token=xxx`  
**权限**：需有效 token（同列表接口）。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | int | 是 | 反馈 ID |
| `token` | string | 是 | 访问令牌 |

**响应示例（成功）**：
```json
{ "code": 200, "message": "success", "data": null }
```

**错误响应**：
```json
// 缺少 id
{ "code": 400, "message": "缺少反馈ID", "data": null }

// ID 不是数字
{ "code": 400, "message": "反馈ID格式错误", "data": null }

// 反馈不存在
{ "code": 404, "message": "反馈记录不存在", "data": null }

// token 无效
{ "code": 502, "message": "Bad Gateway", "data": null }
```

---

## 如何配置反馈系统 token

在 Cloudflare Workers 的 KV 绑定 `CONFIG_KV` 中添加键值对：

- **键**：`suppost_tokens`
- **值**：`token1,token2,admin123` （多个 token 用英文逗号分隔，注意不要有空格）

> 注意：不配置该键或值为空，则反馈列表和删除接口将全部返回 502（Bad Gateway）。  
> 建议使用随机生成的强 token（例如 `uuidgen` 产生的字符串）。

---

## 数据库表结构（自动创建）

```sql
CREATE TABLE IF NOT EXISTS suppose (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  main TEXT NOT NULL,
  user_ua TEXT,
  time INTEGER NOT NULL
);
```

索引建议（可选，手动执行）：
```sql
CREATE INDEX idx_suppose_time ON suppose(time DESC);
```

---

如果你希望把上述内容**完整合并到之前的 README 中**，可直接替换原有“反馈系统说明”章节。另外，原 README 中提到的“内置速率限制”在实际代码中并未实现，如需该功能可另行开发。


---

### 📦 部署检查清单

更新完 README 后，为了确保新功能正常运行，别忘了检查以下几点：

1.  **KV 配置**: 在 `wrangler.toml` 或 Cloudflare 仪表盘里，确认 `CONFIG_KV` 绑定中包含 `suppost_tokens` 键，值是用英文逗号分隔的 token 列表（例如 `token1,token2`）。
2.  **D1 数据库**: 新版本代码会自动创建 `suppose` 表，你无需手动操作。
3.  **CORS 调整**: 已更新 `Access-Control-Allow-Methods` 包含 `POST` 方法，确保前端能正常提交。
4.  **速率限制**: 如果添加的反馈接口在你的限流范围内，需要注意配置。

如果数据库表 `suppose` 没有自动创建，你需要**重新部署一次 Worker**，触发初始化逻辑执行建表操作。
