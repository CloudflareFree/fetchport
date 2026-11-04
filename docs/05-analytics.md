# Google Analytics 4

## 现状

| 项 | 值 |
|---|---|
| GA4 账号 | Soulock（`accounts/413724658`） |
| 属性 | `properties/561080392` |
| 数据流 | EdgeMirror（`dataStreams/16235261657`） |
| 测量 ID | `G-CHDLLWY51X` |
| defaultUri | `https://mirror.137101.xyz` |
| GCP 项目 | `soulock`（890279449637） |

## 站点侧实现

`public/index.html` 的 `<head>` 里两行：

```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-CHDLLWY51X"></script>
<script src="/assets/ga.js?v=1"></script>
```

引导逻辑在 `public/assets/ga.js`（**外链，不是内联**）：

```js
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag("js", new Date());
gtag("config", "G-CHDLLWY51X");
```

**为什么必须是外链**：CSP 是 `script-src 'self' …`，内联脚本会被浏览器拒绝执行，
且只在运行时暴露 —— 页面源码看起来完全正常，但 GA 收不到任何数据。

CSP 需要同时放行的域名（`public/_headers`）：

```
script-src  'self' https://static.cloudflareinsights.com https://www.googletagmanager.com
connect-src 'self' https://cloudflareinsights.com
            https://www.google-analytics.com https://*.google-analytics.com
            https://*.analytics.google.com https://www.googletagmanager.com
frame-src   https://www.googletagmanager.com
```

## 为什么用服务账号而不是登录授权

用户 OAuth 路径是**关闭的**：

- `analytics.*` 是敏感 scope，gcloud 的内置客户端没为它们通过 Google 验证
- 尝试授权时 Google 直接拒绝：「此应用已被阻止」
- `gcloud auth login` 本身也不接受 `--scopes` 参数

服务账号不需要任何浏览器同意流程，只凭私钥调用 API。

## 三层权限，缺一不可

### 层 1：API 启用（需用户账号）

```bash
export PATH=/opt/cloudflare-sites/google-cloud-sdk/bin:$PATH
gcloud config set account wuyunweb@gmail.com
gcloud services enable analyticsadmin.googleapis.com analyticsdata.googleapis.com --project soulock
```

服务账号通常没有 `serviceusage.services.enable` 权限，所以这步必须用用户账号。

缺了会报 `SERVICE_DISABLED`。

### 层 2：带正确 scope 的 token（需自签）

```bash
gcloud auth activate-service-account --key-file=/opt/cloudflare-sites/ga-service-account.json
gcloud auth print-access-token    # ← 不行，只有 cloud-platform
```

Analytics API 严格校验专用 scope，用上面这个 token 会得到
`403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`。

正确做法是用私钥签 JWT，显式请求 scope：

```bash
NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  node /opt/cloudflare-sites/ga_token.mjs > /tmp/ga_token.txt

TOKEN=$(cat /tmp/ga_token.txt)
```

`NODE_USE_ENV_PROXY=1` 不能省 —— Node 的 `fetch` 默认不读 `https_proxy` 环境变量。

token 有效期 1 小时，每次使用前重新签。

### 层 3：GA 账号里授权服务账号

服务账号邮箱：`lrb-898@soulock.iam.gserviceaccount.com`

在 analytics.google.com → 管理 → 账号访问管理 → 添加用户，角色给「编辑者」或
「管理员」。

缺了会返回 403 `The caller does not have permission`。

## 常用 API 调用

### 列账号与属性

```bash
curl -s --proxy http://127.0.0.1:7897 \
  -H "Authorization: Bearer $TOKEN" \
  "https://analyticsadmin.googleapis.com/v1beta/accountSummaries"
```

### 创建数据流

**`type` 是数字枚举，`1` 表示 web stream**：

```bash
curl -s --proxy http://127.0.0.1:7897 -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://analyticsadmin.googleapis.com/v1beta/properties/561080392/dataStreams" \
  --data '{"type":1,"displayName":"EdgeMirror","webStreamData":{"defaultUri":"https://mirror.137101.xyz"}}'
```

常见错误：

| 写法 | 结果 |
|---|---|
| `"type": "WEB_STREAM"` | 400 Invalid value |
| `"type": 2` 或 `3` | 400 "To create app streams, use the Firebase API" |
| `"type": 1` | ✅ |

### 重命名数据流

必须带 `updateMask`，否则报 `update_mask.paths_list was empty`：

```bash
curl -s --proxy http://127.0.0.1:7897 -X PATCH \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://analyticsadmin.googleapis.com/v1beta/properties/561080392/dataStreams/16235261657?updateMask=displayName" \
  --data '{"displayName":"EdgeMirror"}'
```

### 实时报表（验证用）

标准报表有约 24 小时延迟，验证要用实时报表：

```bash
curl -s --proxy http://127.0.0.1:7897 -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://analyticsdata.googleapis.com/v1beta/properties/561080392:runRealtimeReport" \
  --data '{"dimensions":[{"name":"unifiedScreenName"}],"metrics":[{"name":"activeUsers"},{"name":"screenPageViews"}]}'
```

正常返回示例：

```json
{"rows":[{"dimensionValues":[{"value":"EdgeMirror — GitHub / Docker / SourceForge 全球加速网关"}],
          "metricValues":[{"value":"1"},{"value":"2"}]}]}
```

### 7 天报表

```bash
curl -s --proxy http://127.0.0.1:7897 -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://analyticsdata.googleapis.com/v1beta/properties/561080392:runReport" \
  --data '{"dateRanges":[{"startDate":"7daysAgo","endDate":"today"}],
           "dimensions":[{"name":"pagePath"}],
           "metrics":[{"name":"screenPageViews"},{"name":"activeUsers"}]}'
```

## 凭证管理

| 文件 | 用途 | 权限 |
|---|---|---|
| `/opt/cloudflare-sites/ga-service-account.json` | 服务账号私钥 | `600`，仅 root |
| `/opt/cloudflare-sites/ga_token.mjs` | 自签 JWT 取 token | — |

密钥轮换：Google Cloud Console → IAM → 服务账号 → 密钥 → 删除旧密钥并新建。
删掉后旧的 token 到期即失效。

**不要**把密钥写进仓库。`.gitignore` 里没有它也绝不能提交。

## AdSense 相关（未接入）

几个硬约束，做之前先了解：

- **AdSense 账号不能通过 API 创建**，只能在 adsense.google.com 注册，`ca-pub-` 发布商 ID 也只能从后台获取
- **API key ≠ 服务账号**。`AIzaSy...` 开头的是 API key，Analytics/AdSense API 不接受；
  需要的是含 `"type":"service_account"` 和 `private_key` 的完整 JSON
- `ads.txt` 放**主域** `137101.xyz/ads.txt`，其下所有子域共享
- 工具站内容单薄，过审大概率被拒 —— 属于内容策略问题，不是技术问题
