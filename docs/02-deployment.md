# 部署与运维

## 当前拓扑

| 项 | 值 |
|---|---|
| 线上域名 | `https://mirror.137101.xyz` |
| GitHub 仓库 | `CloudflareFree/edgemirror`（public） |
| Cloudflare Account | `8927f17b0f67ecd3536a7e9ba831c0f4` |
| Zone | `137101.xyz`（`d0da6c7c024f89a9cf1ad4cdefaa3c1f`） |
| Pages 项目 | `edgemirror` → `edgemirror-9k1.pages.dev` |
| GA4 属性 | Soulock / `properties/561080392` |
| GA4 测量 ID | `G-CHDLLWY51X`（数据流 EdgeMirror） |
| 本地目录 | `/opt/cloudflare-sites/edgemirror` |

## 自动部署链路

```
git push origin main
        │
        ▼
Cloudflare Pages 拉取 GitHub 代码
   clone_repo → build → deploy
        │
        ▼
https://mirror.137101.xyz
```

**不需要在本地跑任何部署命令。** 验证一次部署是否真的由 Git 触发：

```bash
cf pages projects deployments list --project-name edgemirror --env production
```

看两件事：
- `deployment_trigger.type` 必须是 `github:push`
- `latest_stage.status` 必须是 `success`

只看 `curl /` 返回 200 是不够的 —— 那只说明「上一次的部署还活着」。

### Pages 构建配置

| 设置 | 值 |
|---|---|
| 生产分支 | `main` |
| 构建命令 | `npm run build`（空操作，纯静态） |
| 输出目录 | `public` |
| 函数目录 | `functions`（自动识别） |
| 预览部署 | 关闭 |

`wrangler` 放在 `optionalDependencies`：构建机执行 `npm install` 时不会下载
wrangler + workerd 那几十 MB，纯静态项目用不上。

### 应急手动部署

Git 触发坏掉时：

```bash
cd /opt/cloudflare-sites/edgemirror
npx wrangler pages deploy public --project-name=edgemirror --branch=main
```

这会创建一次 **direct upload** 部署，**不改变 Git 关联**：下次 push 仍会正常触发自动构建。

## 凭证与常见故障

### cf CLI 的 OAuth token 会轮换

`CLOUDFLARE_API_TOKEN` 不要缓存，每次现读：

```bash
cf auth whoami   # 先刷新，顺带确认登录状态
export CLOUDFLARE_API_TOKEN=$(python3 -I -c \
  "import json;print(json.load(open('/root/.config/cloudflare/config/default.json'))['oauth_token'])")
export CLOUDFLARE_ACCOUNT_ID=8927f17b0f67ecd3536a7e9ba831c0f4
```

| 报错 | 含义 | 处理 |
|---|---|---|
| `Invalid access token [code: 9109]` | token 过期 | `cf auth whoami` 刷新后重新读取 |
| `Rate limited [code: 10429]` | 部署太频繁 | 等约 90 秒重试 |

### cf CLI 的坑

- `cf pages projects create` 必须用 `--name`，位置参数会报 `Unknown command`
- `cf dns records create` 只接受 `--body` JSON —— 直接用 REST API 更省事
- `cf pages projects connect-source` 的必填 flag 是一个一个挤出来的（`path_excludes`
  → `pr_comments_enabled` → …），**直接用 REST**：

```bash
curl -sX POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/edgemirror/source" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" --data '{
  "type":"github","config":{
    "owner":"CloudflareFree","owner_id":"348646252",
    "repo_id":"1436126996","repo_name":"edgemirror",
    "production_branch":"main","deployments_enabled":true,
    "production_deployments_enabled":true,"preview_deployment_setting":"none",
    "pr_comments_enabled":false,"path_includes":["*"],"path_excludes":[]}}'
```

### 域名与 DNS

```bash
cf pages projects domains create edgemirror --name mirror.137101.xyz

curl -sX POST "https://api.cloudflare.com/client/v4/zones/d0da6c7c024f89a9cf1ad4cdefaa3c1f/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"type":"CNAME","name":"mirror","content":"edgemirror-9k1.pages.dev","proxied":true,"ttl":1}'
```

域名生效需要几分钟，期间会看到 **522**，属正常。判据是最终 `curl` 到 200。

### 资产缓存必须短

`/assets/*` 用 `max-age=0, must-revalidate`，并在 `index.html` 里给引用加 `?v=N`。

> 这是踩过的真实故障：曾经设了 7 天缓存，部署后老访客继续执行旧 `app.js`，
> 表现为「代码改了但线上没变」。排查很久才定位。

改动前端资源后记得 bump `?v=` 的值，否则浏览器仍可能用旧的。

## 网络环境

本机访问 Google 需要代理：

| 项 | 值 |
|---|---|
| 代理端口 | `127.0.0.1:7897`（**不是 7890**） |
| 内核 | mihomo，配置 `/etc/mihomo/config.yaml`，控制器 `127.0.0.1:9090` |
| Node fetch | **不读** `https_proxy`，必须加 `NODE_USE_ENV_PROXY=1` |

节点失效时可重载配置并切换：

```bash
curl -sX PUT --noproxy '*' "http://127.0.0.1:9090/configs?force=true" \
  -H "Content-Type: application/json" --data '{"path":"/etc/mihomo/config.yaml"}'
```

GitHub 相关：`github.com` 的 release 下载会超时，走 `ghfast.top` 代理，
并用 GitHub API 返回的 `digest` 校验 sha256。

`git push` 偶发 `HTTP/2 stream 1 was not closed cleanly` —— 直接重试即可。

## 日常操作

### 部署后提交 Google Sitemap

新增公开页面或变更 sitemap 后，先确认 Git 部署成功、线上 sitemap 和目标页面可访问，
再按 [Search Console 步骤](06-search-console.md) 执行 `npm run seo:submit`。
通过 `npm run seo:status` 查看 sitemap 处理情况，通过 `npm run seo:inspect` 查看首页索引状态。
提交成功表示 Google 已接收 sitemap，不表示页面已抓取或已收录。

### 换加速节点

编辑 `functions/_config/nodes.js`：

1. 挂掉的节点改 `enabled: false`（保留配置便于恢复）
2. 新增节点填 `id` / `name` / `baseUrl` / `services`
3. `git commit && git push`

前端零改动，节点列表、切换按钮、状态表格全部由这份配置驱动。

### 看节点健康

```bash
curl -s https://mirror.137101.xyz/api/health | jq '.summary'
```

健康探测直连镜像站且**不跟随重定向**，避免每次体检都下载一遍探测文件。
