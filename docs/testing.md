# 测试策略

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
```

Linux 缺浏览器依赖时用 `npx playwright install --with-deps chromium`。本地已有 Chromium 时可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定；CI 使用 Playwright 自带 Chromium。

| 层次               | 行为                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| Biome / TypeScript | 格式、常见问题、前后端和协议类型                                     |
| 协议测试           | 空白、超长、未知字段、转写来源、点选目标与版本                       |
| 真实 SQLite        | 请求去重、ID 内容冲突、版本冲突、重启恢复、独立连接事务、失效目标    |
| HTTP 接口          | 待执行状态、200/201/400/409、Host/Origin、无需密钥的健康检查         |
| Playwright         | 响应丢失重试不重复、电脑提交、大屏同步、刷新恢复、离线修改与重连追赶 |
| 生产构建           | 协议包、服务与网页构建                                               |

单元测试使用临时数据库；浏览器每次运行使用独立临时数据库及固定开发端口，不复用用户的开发服务器。离线测试使用独立浏览器上下文继续写入，恢复后验证可见结果，不靠固定等待推进剧情。

CI 在 Ubuntu/macOS 执行 `npm ci` 与 `npm run check`，覆盖 SQLite 原生依赖；Ubuntu 另跑浏览器测试，失败上传报告和 trace。原型 HTML 不参与自动格式化。

后续补充：Codex 消息分片、进程退出、审批、补充要求、中断和恢复；灵矽部分转写不执行、最终提交去重及两类停止；预览失败、端口占用、目标过期和消息来源。

真机验收单独记录麦克风距离、回声、多人发言、AirPlay 重连与大屏可读性。CI 不需要供应商密钥、麦克风和电视，也不把这些算作已验证。
