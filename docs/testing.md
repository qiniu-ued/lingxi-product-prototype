# 测试策略

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
```

Linux 缺浏览器依赖时用 `npx playwright install --with-deps chromium`。本地已有 Chromium 时可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定；CI 使用 Playwright 自带 Chromium。

| 层次               | 行为                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| Biome / TypeScript | 格式、常见问题、前后端和协议类型                                               |
| 协议测试           | 空白、超长、未知字段、转写来源、点选目标与版本                                 |
| 真实 SQLite        | 请求去重、ID 内容冲突、版本冲突、重启恢复、独立连接事务、失效目标              |
| HTTP 接口与 SSE    | 待执行状态、200/201/400/409、Host/Origin、健康检查、初始快照、广播、重连与关闭 |
| Playwright         | 响应丢失重试不重复、电脑提交、大屏同步、刷新恢复、离线修改与重连追赶           |
| 生产构建           | 协议包、服务与网页构建                                                         |
| 真实进程           | 编译后服务启动、两端 HTML 与 JS 资源、API 写入、进程重启后完整会话恢复         |
| 运行包             | 干净目录安装生产依赖、打包、实际解压、原生 SQLite 与启动器可运行               |

单元测试使用临时数据库；浏览器每次运行使用独立临时数据库及固定开发端口，不复用用户的开发服务器。离线测试使用独立浏览器上下文继续写入，恢复后验证可见结果，不靠固定等待推进剧情。

`npm run check` 包含覆盖率和真实进程检查。覆盖率门槛为 statements/lines/functions 85%、branches 75%，由 `vitest.config.ts` 强制执行；启动入口 `apps/server/src/index.ts` 由编译后真实进程验证，不计入单元覆盖率。报告位于 `coverage/`。

CI 在 Ubuntu 24.04、macOS 15 Apple Silicon 和 Intel 执行 `npm ci` 与 `npm run check`，覆盖 SQLite 原生依赖；Ubuntu 另跑浏览器测试，失败上传报告和 trace。通过后两个 Mac runner 分别构建并验证运行包。原型 HTML 不参与自动格式化。通过 GitHub 分支保护要求 CI 通过仍需管理员单独配置，workflow 本身不会禁止管理员合并失败 PR。

按改动选择额外检查：

```sh
# 已构建的生产进程检查
npm run smoke
# 干净安装、打包与解压启动验证；只构建当前系统/架构
npm run release:pack
# high/critical 生产依赖问题会失败
npm run audit:production
# 需要 Go，固定版本校验 workflow 语法与表达式
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12
```

运行包与覆盖率报告的下载及保存期限见 [运行与部署](deployment.md)。CI 不自动安装到个人电脑，也不自动合并 Dependabot PR。

后续补充：Codex 消息分片、进程退出、审批、补充要求、中断和恢复；灵矽部分转写不执行、最终提交去重及两类停止；预览失败、端口占用、目标过期和消息来源。

真机验收单独记录麦克风距离、回声、多人发言、AirPlay 重连与大屏可读性。CI 不需要供应商密钥、麦克风和电视，也不把这些算作已验证。
