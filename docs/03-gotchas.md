# 踩坑记录

按主题归档。每一条都是实际发生过的故障，包含现象、根因、修复。

---

## 1. Range 请求返回的字节数是错的

**现象**

```bash
curl -r 0-99 .../raw.githubusercontent.com/torvalds/linux/master/README
# 206，但只有 63 字节，Content-Range 说 bytes 0-99/330
# 而文件实际是 496 字节
```

**根因**

github.com 背后的 Fastly 按 **gzip 之后的字节**计算区间，同时把**压缩后的大小**
当作资源总量报在 `Content-Range` 里，返回的却是解码后的正文（不带 `Content-Encoding`）。
三个数字互相矛盾。

后果：任何断点续传都会拼出损坏文件；开放式区间 `bytes=248-` 也会返回错误长度。
二进制 release 资产不受影响，只有可压缩文本会中招。

**头部判断全都不可靠**：`content-length` 时有时无；长度校验对开放式区间也失效
（`330-248` 恰好等于实际返回长度）。

**修复**

`functions/_lib/proxy.js`：任何 206 且声明的资源总量 ≤ 8 MB，**丢弃上游切片**，
改为完整拉取一次后在 Worker 内自己切。大文件（二进制资产）走原流式路径。

同时：

- 给 206 响应加 `cache-control: … no-transform`，阻止 Cloudflare 边缘二次压缩
- Range 请求强制 `accept-encoding: identity`

**验证**

496 字节文件全部区间正确；`248 + 248` 续传与原文逐字节一致；15 MB release 包
完整下载且可正常解压；越界返回 416。

---

## 2. 全文回退时的截断会静默产出损坏的 206

**现象**

续传测试偶发失败：`p1` 只有 92 字节，但状态码是 206、`Content-Range` 声称 3017 字节。

**根因**

修复 #1 引入的「全文拉取再切片」路径里，如果那次 fetch 在传输中途被打断，
`arrayBuffer()` 会返回一个短 buffer；用它切片仍然会生成一个**看起来合理**的 206。

更麻烦的是：响应被截断时运行时会把 `content-length` 头剥掉，所以拿它做校验
等于没校验。

**修复**

比对两个来源，取可用的那个：

```js
const declared = Number(full.headers.get("content-length") || 0);
const expected = declared > 0 ? declared : knownTotal || 0;  // knownTotal 来自原始 Content-Range
if (expected > 0 && read.byteLength < expected) { /* 重试 */ }
```

最多重试一次；两次都失败返回 **502**，而不是把残缺数据当成功返回。
宁可报错，也不能给下载器喂坏字节。

**验证**

失败注入测试（让第一次全文拉取只返回 92 字节）确认会重试并最终拼出完整文件。

---

## 3. Docker registry 选择分裂

**现象**

`/v2/` 挑战指向 dockerhub，`/token` 却从 ghcr 签了 token，拉取时
`403 {"code":"DENIED","message":"invalid token"}`。

**根因**

两个 handler 各自独立选 registry，可能选出不同的结果。而 token 只对签发它的
registry 有效。

**修复**

抽出 `functions/_lib/registry.js` 共用同一个选择器与 60 秒缓存。
并给 token 加前缀 `v1.<registry-id>.<token>`，拉取时按前缀精确路由回签发方。
客户端视 token 为不透明字符串，对此无感知。

---

## 4. Docker Hub 匿名限流（无法用代码解决）

**现象**

```json
{"errors":[{"code":"TOOMANYREQUESTS","message":"You have reached your unauthenticated pull rate limit."}]}
```

**根因**

Docker Hub 按**源 IP**限制匿名拉取，而 Cloudflare Workers 的所有请求共用一组
出口 IP —— 匿名配额基本永远处于耗尽状态。这是硬限制。

**处理**

- 标记该 registry 限流 60 秒，期间跳过
- 带标签的 token 无法跨 registry 重放，此时如实返回 `429` + `retry-after`，
  而不是误导性的 403
- **根治**：配一个免费 Docker Hub 账号提额

```bash
npx wrangler pages secret put DOCKERHUB_USER   --project-name=edgemirror
npx wrangler pages secret put DOCKERHUB_TOKEN  --project-name=edgemirror
```

`DOCKERHUB_TOKEN` 是 Personal Access Token（Account Settings → Security），不是密码。

---

## 5. 资产长缓存导致「代码改了线上没变」

**现象**

前端改动部署成功，线上仍是旧行为。

**根因**

`/assets/*` 设了 7 天缓存。部署后老访客继续使用缓存的旧 `app.js`。

更隐蔽的是：这会让人误以为是部署失败，从而反复重新部署 —— 而问题根本不在部署。

**修复**

- `/assets/*` 改为 `max-age=0, must-revalidate`
- `index.html` 里的引用加 `?v=N`，每次前端变更 bump
- 需要时清边缘缓存：

```bash
curl -sX POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"purge_everything":true}'
```

---

## 6. GA4 内联脚本被自己的 CSP 拦掉

**现象**

E2E 报错：

```
Refused to execute inline script because it violates the following
Content Security Policy directive: "script-src 'self' …"
```

页面看起来正常，但 GA 完全收不到数据。

**根因**

`script-src 'self'` 不允许内联脚本。这是运行时错误，`curl` 页面源码看不出来。

**修复**

把 GA 引导逻辑移到外部文件 `public/assets/ga.js`，并放行必要域名：

```
script-src 'self' https://static.cloudflareinsights.com https://www.googletagmanager.com
connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com
            https://*.analytics.google.com https://www.googletagmanager.com
frame-src https://www.googletagmanager.com
```

**不要**用 `'unsafe-inline'` 图省事。

**教训**：CSP 违规只在浏览器运行时暴露，必须用无头浏览器 E2E 断言
「零 console 错误」，光看 curl 是不够的。

---

## 7. GA4 API 的 scope 与 enum 陷阱

### 7.1 浏览器授权被 Google 阻止

`gcloud auth login` 拿不到 `analytics.*` scope。试图用
`gcloud auth application-default login --scopes=...analytics.edit` 补上时，
Google 直接拒绝：

> 此应用已被阻止 —— 该应用试图访问您 Google 账号中的敏感信息。

**根因**：`analytics.edit` / `analytics.readonly` 是敏感 scope，只有通过 Google
验证的应用才能申请；gcloud 的内置客户端没有为它们过审。这是硬限制。

另外 `gcloud auth login` **根本不接受** `--scopes` 参数（只有
`application-default login` 接受）。

**结论**：用户 OAuth 这条路走不通，只能用服务账号。

### 7.2 服务账号 token 的 scope 也不对

```bash
gcloud auth activate-service-account --key-file=ga-service-account.json
gcloud auth print-access-token   # 只能拿到 cloud-platform
```

Analytics API 严格校验专用 scope，返回
`403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`。

**修复**：用私钥自己签 JWT，显式请求 analytics scope。工具在
`/opt/cloudflare-sites/ga_token.mjs`：

```bash
NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7897 \
  node /opt/cloudflare-sites/ga_token.mjs > /tmp/ga_token.txt
```

token 有效期 1 小时，每次用之前重新签。

### 7.3 建数据流的 type 是数字

```json
{"type": "WEB_STREAM", ...}   // ❌ 400 Invalid value
{"type": 2, ...}              // ❌ "To create app streams, use the Firebase API"
{"type": 1, ...}              // ✅ 1 = web stream
```

改名字要带 updateMask：

```bash
curl -sX PATCH ".../dataStreams/<id>?updateMask=displayName" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data '{"displayName":"EdgeMirror"}'
```

### 7.4 三层权限，缺一不可

| 层 | 内容 | 缺了会怎样 |
|---|---|---|
| API 启用 | `analyticsadmin` / `analyticsdata` 在项目上启用 | `SERVICE_DISABLED` |
| token scope | 自签 JWT 带 `analytics.readonly`+`edit` | `ACCESS_TOKEN_SCOPE_INSUFFICIENT` |
| GA 账号授权 | 服务账号邮箱加为 GA 账号用户 | 403 |

启用 API 要用**用户账号**（服务账号一般没有 `serviceusage.services.enable`）：

```bash
gcloud config set account wuyunweb@gmail.com
gcloud services enable analyticsadmin.googleapis.com analyticsdata.googleapis.com --project soulock
```

服务账号邮箱：`lrb-898@soulock.iam.gserviceaccount.com`，
在 analytics.google.com → 管理 → 账号访问管理中加为编辑者。

### 7.5 验证要用实时报表

标准报表有约 24 小时延迟，刚接入时是空的，容易误判为没生效。
用 `runRealtimeReport`，几秒内就能看到：

```bash
curl -sX POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://analyticsdata.googleapis.com/v1beta/properties/561080392:runRealtimeReport" \
  --data '{"metrics":[{"name":"activeUsers"},{"name":"screenPageViews"}]}'
```

---

## 8. AdSense 的几个硬约束

- **账号不能通过 API 创建**，只能在网页后台注册，`ca-pub-` 开头的发布商 ID 也只能从后台拿
- **API key ≠ 服务账号密钥**。`AIzaSy...` 是 API key，Analytics/AdSense API 根本不接受；
  需要的是含 `"type": "service_account"` + `private_key` 的完整 JSON
- `ads.txt` 部署在**主域**（apex），其下所有子域共享这一份
- 工具站内容单薄，过审大概率被拒 —— 这是内容问题，不是代码问题

---

## 9. 其他小坑

| 现象 | 原因 / 处理 |
|---|---|
| `cf pages projects create edgemirror` 报 `Unknown command` | 必须用 `--name` |
| `cf dns records create --type ...` 报 `Unknown arguments` | 只接受 `--body` JSON，改用 REST |
| `git push` 报 `HTTP/2 stream 1 was not closed cleanly` | 重试即可 |
| Node `fetch failed` 但 curl 正常 | Node 不读 `https_proxy`，加 `NODE_USE_ENV_PROXY=1` |
| `gcloud auth print-access-token` 返回空 | 检查当前活跃账号是不是被切走了 |
| wrangler dev 端口占用 | 8788 被 docker-proxy 占着，换 8891 |
| 后台进程被 SIGKILL | 用 `setsid nohup … &` 脱离进程组 |
