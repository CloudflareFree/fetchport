# 测试

## 两套测试

```bash
node test/integration.mjs        # 94 项
node test/e2e.mjs                # 30 项
```

两者都是**真实环境**测试，不打 mock。

### 集成测试

直接 `import` Worker 模块，用真实 `Request` 调用 handler：

```js
const res = await onRequestGet({
  request: new Request("https://fetchport.137101.xyz/gh/…", { headers: { range: "bytes=0-49" } }),
  env: {}, params: {},
});
```

所以本地通过 = 线上行为一致。覆盖：

| 组 | 内容 |
|---|---|
| 配置 | `/api/nodes` 字段完整性、redirect 节点必须暴露 `baseUrl` |
| GitHub | 302 语义、Location 指向镜像站、无响应体、白名单拒绝 |
| GitHub direct | 真实字节、Range 精确性、续传拼接、越界 416、release 资产 |
| SourceForge | 透传 302、白名单 |
| Docker | 挑战头、token 签发、manifest 拉取、TTL 上限 |
| 健康检查 | 并行探测、耗时上限、单节点、未知节点 404 |
| 静态资源 | 12 个必需文件存在且非空 |
| SEO | 30+ 项：title/canonical/OG/JSON-LD/单 h1/CSP 合规等 |

### E2E 测试

用 CDP 驱动无头 Chrome，验证真实浏览器行为：

```bash
node test/e2e.mjs https://fetchport.137101.xyz
```

覆盖：页面加载、三种服务切换、链接转换正确性、节点切换、键盘导航、
FAQ 展开、**零 console 错误**、以及 375/768/1440 三档响应式无横向滚动。

> E2E 的「零 console 错误」断言抓到过一个 curl 完全看不出的 bug：
> GA 内联脚本被 CSP 拦截。这类问题只能靠真实浏览器发现。

## 测试环境要求

- Node 24（`fetch` / `Headers` / `Request` 原生可用）
- E2E 需要 Playwright 的 Chromium：`/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome`
- 部分用例依赖外网（GitHub / SourceForge / registry）

## 已知的测试脆弱性

集成测试会真实访问上游，因此**网络抖动会导致偶发失败**。典型表现：

```
· direct: resume halves concatenate to the whole file — 3109 vs 6034 bytes
```

遇到这种，先单独重跑确认；如果稳定复现才是代码问题。

历史上有一次「偶发」其实是真 bug（全文回退路径静默截断），已修复并加了失败注入
测试。所以**不要把偶发失败直接归因于网络** —— 至少验证三次。

## 辅助工具

```bash
node test/shot.mjs <url> <out.png> [--full] [--width=1440] [--height=900] [--scroll=N]
node test/probe.mjs <url> <js-file>     # 在真实页面里执行任意表达式
```

`probe.mjs` 很适合临时排查：把要执行的 JS 写进文件，它会返回结果。

示例，验证转换输出：

```js
// /tmp/q.js
(async () => {
  const i = document.querySelector("#url-input");
  i.value = "https://github.com/astral-sh/uv/releases/download/0.5.11/uv.tar.gz";
  document.querySelector("#proxy-form").requestSubmit();
  await new Promise(r => setTimeout(r, 400));
  return document.querySelector("#output-url").textContent;
})();
```

```bash
node test/probe.mjs https://fetchport.137101.xyz /tmp/q.js
```

## 部署后必做的验证

只看 `curl /` 返回 200 **不够**，那只说明上一次部署还活着。完整清单：

```bash
# 1. 确认是 Git 触发的构建
cf pages projects deployments list --project-name edgemirror --env production
#    要求 trigger=github:push 且 latest_stage=success

# 2. 关键路径
curl -sI https://fetchport.137101.xyz/gh/raw.githubusercontent.com/torvalds/linux/master/README
#    期望 302 + content-length: 0 + location 指向镜像站

# 3. 白名单生效
curl -s -o /dev/null -w '%{http_code}\n' https://fetchport.137101.xyz/gh/evil.example.com/x
#    期望 400

# 4. 页面与浏览器行为
node test/e2e.mjs https://fetchport.137101.xyz
```
