# Google Search Console：网址发现与索引检查

## 部署后的新增步骤

1. **检查技术障碍**：目标页面应返回 HTTP 200；`robots.txt` 允许 Googlebot 抓取；
   HTML robots meta 和 HTTP `X-Robots-Tag` 均无 `noindex`；canonical 指向预期公开网址。
   同时检查 Cloudflare/WAF 是否阻挡 Googlebot。普通客户端访问成功不能证明 Googlebot 已抓取成功。
2. **提交 Sitemap**：将新增的可索引规范网址放入 `public/sitemap.xml`，部署成功后通过
   Search Console API 提交。当前网站只有一个独立页面，`#services`、`#nodes` 等是页内锚点，
   不应作为独立页面写入 sitemap。`lastmod` 只随页面实质内容更新，不要每次提交都改日期。
3. **添加内部链接**：有独立新页面时，在相关旧页面加入可抓取的 `<a href="…">` 链接。
   优先选择已收录、内容相关的旧页面；目前没有旧文章目录，不虚构已收录文章或新页面。
4. **少量页面手动请求编入索引**：在 Search Console 的“网址检查”中输入完整网址，
   必要时先测试实际网址，然后点击“请求编入索引”。此操作需要在网页控制台完成。
5. **跟踪结果**：读取 sitemap 处理状态和网址检查结果，分清“已提交”“已处理”“已索引”。
   建议 1–3 天后复查 sitemap，7–14 天后复查索引；这些是运维观察窗口，不是 Google 时效承诺。

## API 能力边界

- Search Console **Sitemaps API** 可以提交 sitemap，帮助 Google 发现网址。
- **URL Inspection API** 只能查询 Google 索引中已有版本的状态，不能发起“请求编入索引”，
  也不能代替实时网址测试。
- Google **Indexing API** 仅适用于包含 `JobPosting` 或 `VideoObject` 中嵌入
  `BroadcastEvent` 的页面。本工具站不符合适用范围。
- sitemap 接收成功、HTTP 200、允许索引都不保证抓取、收录或排名。

## 当前属性与鉴权

| 项 | 值 |
|---|---|
| Search Console 属性 | `sc-domain:137101.xyz`（覆盖子域 `mirror.137101.xyz`） |
| Sitemap | `https://mirror.137101.xyz/sitemap.xml` |
| 首页规范网址 | `https://mirror.137101.xyz/` |
| 服务账号 | `lrb-898@soulock.iam.gserviceaccount.com` |
| 2026-11-04 实测属性权限 | `siteFullUser` |

Google Cloud 项目需启用 Search Console API；服务账号还需在 Search Console 属性的
“设置 → 用户和权限”中取得完整用户或所有者权限。GA4 权限不等于 Search Console 权限。

提交使用 `https://www.googleapis.com/auth/webmasters` scope；只读查询使用
`https://www.googleapis.com/auth/webmasters.readonly`。脚本自行签 JWT 获取短期 token，
不输出 token，不将私钥放入仓库、前端或 Pages 环境。

## 操作命令

在项目根目录执行（Node 24+）：

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/opt/cloudflare-sites/ga-service-account.json
export NODE_USE_ENV_PROXY=1
export https_proxy=http://127.0.0.1:7897
export http_proxy=http://127.0.0.1:7897

npm run seo:submit    # PUT 提交 sitemap，然后 GET 读取处理状态
npm run seo:status    # 只读取处理状态
npm run seo:inspect   # 只查询首页的已有索引状态
```

可通过 `GSC_SITE_URL`、`GSC_SITEMAP_URL`、`GSC_INSPECTION_URL` 覆盖默认属性、sitemap
和检查网址。域属性保留 `sc-domain:` 前缀；URL 前缀属性必须与控制台中的值完全一致。
不要在访客页面加载时调用提交，也不需要每次访问或未变更时反复提交。

### 成功判据与排错

- 提交调用返回 HTTP 2xx、空响应体是正常成功，脚本输出 `sitemap-submitted` 回执。
- 读取结果中 `isPending: true` 表示等待处理；结合 `lastSubmitted`、`lastDownloaded`、
  `errors` 和 `warnings` 判断后续结果，不要把未提供的字段当作零。
- 网址检查结合 `verdict`、`coverageState`、`indexingState`、`robotsTxtState`、
  `pageFetchState`、`lastCrawlTime` 和 Google 选择的 canonical 判断。
- 403 时按错误检查 API 是否启用、token scope 和属性授权；404 时确认属性 ID、
  sitemap 地址和提交记录。不要把 sitemap 未提交的 404 当成网页不存在。
- 若需要撤销错误提交，可在 Search Console 的 Sitemaps 页面移除记录；这不会删除
  Google 已发现的网址，也不等于从搜索结果移除页面。

## “无法抓取”的排查记录（2026-11-04）

线上标准 sitemap XML 与 robots.txt 均能返回 200，robots 允许首页、sitemap 与静态资源。
Search Console API 当时仍报告 `isPending: true`，未返回 `lastDownloaded`；不能从空白的
“上次读取时间”推断为 XML 错误，也不能把提交回执当作抓取成功。

Cloudflare 安全事件确认 `Python-urllib/3.14` 请求 `/sitemap.xml` 被 `source: bic`、
`ruleId: bic` 拦成 403。使用 Googlebot / Google-InspectionTool User-Agent 的本机探测
返回 200；这些探测不是 Google 实际抓取的证据，事件中也未发现 Googlebot 被拦。

已配置范围仅限 `mirror.137101.xyz` 的 `/robots.txt` 与 `/sitemap.xml` 的 WAF 自定义跳过规则：

```text
phase: http_request_firewall_custom
expression: (http.host eq "mirror.137101.xyz" and http.request.uri.path in {"/robots.txt" "/sitemap.xml"})
action: skip
action_parameters: {"products": ["bic"]}
ref: edgemirror_public_crawl_files
```

规则集 ID：`02e1c48b1a68405d8a4cea53e16d841b`；规则 ID：`8a24c7630af14024bc2677df4d926aeb`。
回滚只需禁用该规则，无需变更整个域的安全配置。此调整针对已复现的爬虫 BIC 障碍，
Google 报错的最终原因仍需其处理结果或真实抓取记录验证。

此次配置规则方式的 `set_config: {"bic": false}` 未消除实测的 403，因此改用官方支持的
`skip.products: ["bic"]`，并删除了前一种配置规则。后续测试中 Python 客户端访问
robots.txt 为 200，但 sitemap.xml 仍为 403，Pages 默认域名的 sitemap 也复现了 403；
因此没有把本次调整记为“爬虫 403 已全面解决”。Googlebot 和 Google-InspectionTool
User-Agent 的请求均为 200。不要叠加全域关闭 BIC 或按 User-Agent 字符串放行全部安全检查。

`robots.txt` 统一允许公开页面和渲染资源，并排除 `/api/`、`/gh/`、`/sf/`、`/v2/` 与
`/token`，避免将接口和代理内容当作站点页面抓取；robots 的禁止抓取不等于从索引移除。
sitemap 只列独立规范首页，不列页内锚点。两个文件显式设置 MIME 类型与 300 秒缓存。

## 官方依据

以下文档已于 2026-11-04 打开核对：

- [Sitemaps API：submit](https://developers.google.com/webmaster-tools/v1/sitemaps/submit)
- [URL Inspection API：inspect](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect)
- [Indexing API 的适用范围](https://developers.google.com/search/apis/indexing-api/v3/using-api)
- [构建与提交 sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
