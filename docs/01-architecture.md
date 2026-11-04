# 架构与请求流

## 全景

```
浏览器 / curl / docker
        │
        ▼
Cloudflare Edge (mirror.137101.xyz, proxied CNAME)
        │
        ├─── 静态资源 ──▶ Pages（public/，全球缓存）
        │
        └─── 函数路由 ──▶ Pages Functions（functions/）
                            │
                            ├── /gh/*  ──▶ 302 ──▶ gh-proxy.com ──▶ GitHub
                            ├── /sf/*  ──▶ 透传 SourceForge 的 302 ──▶ *.dl.sourceforge.net
                            ├── /v2/*  ──▶ registry（dockerhub / ghcr）※本站转发
                            └── /api/* ──▶ 配置与健康数据（纯计算）
```

关键分界：**GitHub 和 SourceForge 的字节都不经过本 Worker**，只有 Docker registry 协议无法重定向、必须由本站转发。

## 目录职责

| 路径 | 职责 |
|---|---|
| `functions/_config/nodes.js` | 唯一需要日常编辑的文件：节点清单、Docker registry 清单、服务描述 |
| `functions/_lib/proxy.js` | 流式转发、白名单校验、Range 修复、CORS、缓存策略 |
| `functions/_lib/registry.js` | registry 选择、token 编解码、限流标记 |
| `functions/gh/[[path]].js` | GitHub 路由（302 或直连） |
| `functions/sf/[[path]].js` | SourceForge 路由（透传 302） |
| `functions/v2/[[path]].js` | OCI/Docker registry 镜像 |
| `functions/token.js` | Docker registry 的 OAuth2 realm 中继 |
| `functions/api/nodes.js` | 前端启动时读取的节点/服务配置 |
| `functions/api/health.js` | 并行探测各节点可用性 |
| `public/` | 单页站点、样式、前端脚本、自托管字体、SEO 文件 |

## 三种节点模式

这是整个设计的核心。`mode` 决定字节走哪条路：

| mode | 行为 | 流量成本 | 适用 |
|---|---|---|---|
| `redirect` | Worker 返回 `302 Location: <baseUrl><原始URL>`，客户端自己去镜像站下载 | **零** | GitHub 镜像站（默认） |
| `direct` | Worker 直接 fetch 源站并转发字节 | 计入 Workers 用量 | 兜底；镜像站全挂时 |
| `upstream` | Worker 转发到镜像站（本站中转内容） | 计入 Workers 用量 | 需要改写响应时 |

默认全部走 `redirect`。实测一次 release 资产下载：

```
HTTP/2 302
content-length: 0
location: https://gh-proxy.com/https://github.com/.../uv-x86_64-unknown-linux-gnu.tar.gz
```

`content-length: 0` 是零流量的直接证据 —— 15 MB 的包由镜像站交付，本站只发了一个跳转头。

## 请求处理顺序（/gh/*）

1. 解析路径，支持两种写法：
   - `/gh/<host>/<path>` —— 例如 `/gh/github.com/user/repo/...`
   - `/gh/https://<完整URL>` —— 用户直接粘贴原始链接
2. **白名单校验**（`assertAllowedHost`）—— 不在名单内直接 400，防止被当作开放代理
3. 按 `?node=` 参数选节点，缺省取第一个 `kind: "primary"` 的节点
4. `redirect` 模式 → 返回 302；`direct` 模式 → 进入 `forward()`

## 前端与后端的契约

`/api/nodes` 返回的 JSON 是前端唯一的配置来源：

```json
{
  "nodes": [{ "id", "name", "region", "flag", "kind", "mode", "baseUrl", "services" }],
  "services": [{ "id", "name", "description", "placeholder", "examples" }]
}
```

- `baseUrl` 必须对前端可见 —— `redirect` 模式下前端要自己拼出镜像地址
- 新增节点只改 `nodes.js`，前端零改动
- 服务切换时节点列表会按 `services` 字段重新过滤

## 为什么不把 Docker 也做成重定向

Docker 客户端写死请求 `/v2/`，并且必须先完成 token 交换（`/v2/` 返回 401 +
`WWW-Authenticate` → 客户端取 token → 带 token 重试）。整个握手必须由同一个端点
完成，无法像普通 HTTP 文件那样把一个 Location 甩给客户端。因此 Docker 流量
必然经过 Worker，这是协议限制，不是实现选择。
