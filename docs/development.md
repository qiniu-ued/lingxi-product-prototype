# 灵矽 · 共创工作台

在沙发或会议室里，用语音、鼠标和键盘共同制作产品；电脑运行 Code Agent，大屏展示成果和进展。

## 当前实现

- 电脑操作台：输入并保存待执行的修改建议。
- 大屏视图：实时同步本地会话，刷新或断线后恢复最新状态。
- 本地服务：SQLite 保存建议，处理重复提交与版本冲突。
- 连接向导：`/setup` 显示真实服务环境，按需检查 Codex CLI、App Server 与认证配置，指导灵矽账号、设备和音频准备。
- 自动检查：格式、类型、协议、持久化、HTTP、双端浏览器与生产构建。

Codex、七牛灵矽的真实适配器，项目启动、元素点选、语音采集及自动投屏尚未实现。启动和测试无需模型账号或密钥，界面明确显示“已保存、尚未执行”。

设计师维护的 39 步原型继续保留在 `source/` 和根 `dist/`。其原始需求保存在 [原型需求快照](reference/original-product-brief.md)，当前设计以 [产品设计](product-design.md) 为准。

## 本地开发

需要 Node.js **24.x** 与 npm **11.x**，可通过 `.nvmrc` 选择 Node 版本。

```sh
npm ci
npm run dev
```

- 操作台：<http://127.0.0.1:5173/>
- 大屏：<http://127.0.0.1:5173/display>
- API 健康检查：<http://127.0.0.1:4310/api/health>

两端在同一台 Mac 的浏览器中打开。使用 macOS 连接 AirPlay 扩展显示器，再把大屏窗口放过去。网页不直接启动 Codex，也不实现 AirPlay 协议；调用 Codex 由本机 Node 服务负责。只部署静态网页不足以运行完整产品。

服务只监听本机回环地址，暂不支持其他参会者的电脑加入。5173 和 4310 端口需空闲。数据默认位于仓库根 `.local/lingxi.db`，已被 Git 忽略；可通过进程环境变量 `LINGXI_DB_PATH` 指定路径。

## 验证与生产运行

```sh
npm run check
npx playwright install chromium
npm run test:e2e
npm run build
npm start
```

`npm run check` 包含静态/类型检查、单元与接口覆盖率、生产构建、真实进程启动与重启恢复。`npm start` 使用构建结果，在 <http://127.0.0.1:4310/> 和 `/display` 提供页面。浏览器测试另行执行，详见 [测试策略](testing.md)。

日常运行推荐将数据放到版本目录之外。Mac 运行包下载、安装、配置、更新、备份与回退见 [运行与部署](deployment.md)。目前不能只部署网页；服务需要在使用 Codex 的那台 Mac 上启动。

原静态演示通过 `npm run prototype` 启动，地址 <http://127.0.0.1:8080/>（需要 Python 3）。其语音、AirPlay、Agent、投票及重连均为预设剧情，不调用真实服务，也不保存真实会话。

## 工程结构

```text
apps/web/             React + Vite，电脑与大屏
apps/server/          Fastify、SSE、SQLite
packages/protocol/    Zod 校验、共享类型、适配器接口
tests/e2e/            Playwright 双端与重连测试
scripts/              生产检查与运行包构建
docs/                 设计、架构、ADR 与测试策略
source/               原交互原型源文件
dist/                 原型导出页面（继续提交到 Git）
```

- [产品设计](product-design.md)
- [系统架构](architecture.md)
- [ADR 0001：技术架构取舍](adr/0001-local-web-architecture.md)
- [Codex、灵矽、AirPlay 与 A2UI 接入](integrations.md)
- [测试策略](testing.md) 与 [实施清单](roadmap.md)
- [运行、交付与更新](deployment.md)
- [Mac 首次运行与连接准备](mac-setup.md)

GitHub Actions 检查 Linux、Apple Silicon 与 Intel Mac，并在 Linux 运行 Chromium 测试；通过后生成两个 Mac 运行包。真实语音、Codex 登录与 AirPlay 留待 Mac 集成验收，CI 不使用模型密钥模拟成功。
