# EdgeMirror 文档

GitHub / Docker / SourceForge 加速网关的技术文档。面向维护者。

| 文档 | 内容 |
|---|---|
| [01-architecture.md](01-architecture.md) | 请求流、目录职责、三种节点模式、为什么 Docker 无法重定向 |
| [02-deployment.md](02-deployment.md) | 自动部署链路、Pages 配置、凭证与常见故障、日常操作 |
| [03-gotchas.md](03-gotchas.md) | 踩坑记录：Range 损坏、截断、registry 分裂、缓存、CSP 等 |
| [04-testing.md](04-testing.md) | 集成/E2E 测试、辅助工具、部署后验证清单 |
| [05-analytics.md](05-analytics.md) | GA4 接入、三层权限、API 用法、AdSense 约束 |

顶层 [README.md](../README.md) 是面向使用者的功能说明和节点配置指南。

## 一句话概括

**GitHub 和 SourceForge 的字节不经过本站**（302 到镜像站），只有 Docker registry
因为协议限制必须由本站转发。

## 快速定位

| 我要… | 看 |
|---|---|
| 换加速节点 | [02](02-deployment.md#换加速节点) → `functions/_config/nodes.js` |
| 搞清楚某个报错 | [03](03-gotchas.md) |
| 部署后验证 | [04](04-testing.md#部署后必做的验证) |
| 改 GA 或查数据 | [05](05-analytics.md) |
| 理解 Range 为什么自己切片 | [03 #1](03-gotchas.md) |
