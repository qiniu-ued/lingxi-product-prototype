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

连接向导的进程测试使用 `tests/fixtures/codex-cli.mjs` 协议替身，验证实际子进程、只读消息、分片通知、登录类型、异常、超时回收与隐私，不调用模型服务。配置操作另用 `tests/fixtures/codex-setup.mjs` 模拟 npm 与官方 OAuth 协议，实际启动子进程，验证 latest 参数、独立目录、验证后切换、失败保留旧安装、请求去重、取消回收、本地 Origin 和严格动作校验。浏览器测试拦截诊断与操作结果，验证先汇总两项状态、按需显示步骤、安装、官方授权窗口、刷新恢复和检查重试，不将替身结果算作真实 Codex 登录成功。生产冒烟检查包含 `/setup` 页面和环境 API。真实 Mac 的 CLI、提供方认证与音频测试按 [连接指南](mac-setup.md)另行验收。

`npm run check` 包含覆盖率和真实进程检查。覆盖率门槛为 statements/lines/functions 85%、branches 75%，由 `vitest.config.ts` 强制执行；启动入口 `apps/server/src/index.ts` 由编译后真实进程验证，不计入单元覆盖率。报告位于 `coverage/`。

CI 在 Ubuntu 24.04、macOS 15 Apple Silicon 和 Intel 执行 `npm ci` 与 `npm run check`，覆盖 SQLite 原生依赖；Ubuntu 另跑浏览器测试，失败上传报告和 trace。通过后两个 Mac runner 分别构建并验证运行包和桌面 ZIP。Linux 浏览器 job 还运行 Electron 集成检查（测试环境使用 headless/no-sandbox；应用代码不关闭生产 sandbox）。原型 HTML 不参与自动格式化。通过 GitHub 分支保护要求 CI 通过仍需管理员单独配置，workflow 本身不会禁止管理员合并失败 PR。

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

## Codecov 接入与徽章

[Codecov 项目页](https://app.codecov.io/gh/qiniu-ued/lingxi-product-prototype) 展示覆盖率趋势、逐文件报告和 PR 变化；README 放置 CI 与 Codecov 徽章，均展示 `main`。首次启用前，以及 main 尚未产生报告时，覆盖率徽章可能显示 `unknown`。

`npm run test:coverage` 输出 `coverage/lcov.info`。CI 的独立 `Codecov coverage` 任务下载 Ubuntu 的报告后上传一次，不重复合并三个操作系统的同一套测试。只上传 LCOV；范围是协议、服务端单元/接口与静态资产边界测试，网页 Playwright 测试和生产进程检查未计入这个百分比。原来的本地覆盖率门槛继续强制执行。

上传使用 GitHub OIDC 短期身份，只有上传任务授予 `id-token: write`，不需要在仓库保存 `CODECOV_TOKEN`。外部 fork 的 PR 跳过此任务，仍然执行已有测试；不使用 `pull_request_target` 执行贡献者代码。

私有仓库首次启用需要有权限的维护者完成 Codecov 侧设置：
1. 在 Codecov 使用 GitHub 登录，为 `qiniu-ued` 安装/授权 [Codecov GitHub App](https://github.com/apps/codecov)，授权范围选择这个仓库。
2. 在 Codecov 项目列表启用 `lingxi-product-prototype`，确认当前组织方案支持该私有仓库。OIDC 负责上传认证，不能代替仓库的服务端访问授权。
3. 重新运行一次 CI，确认上传步骤成功，并在 Codecov 项目页看到对应提交。合并后 main 的首次 CI 建立主分支基线，后续 PR 才能比较覆盖率变化。
4. 如果私有仓库徽章仍为 `unknown`，从 Codecov 仓库设置的 Badges 页面复制其提供的私有徽章 Markdown，替换 README 的 Codecov 那一行。徽章访问令牌与上传令牌用途不同；不要把 `CODECOV_TOKEN` 或 GitHub token 放进图片 URL。

`codecov.yml` 配置整体与新增行 85% 的 Codecov 状态检查，PR 评论在覆盖率发生变化时更新。要显示这些检查和评论，Codecov App 也需要在仓库中完成授权；通过 GitHub 分支保护将它们设为必需仍需维护者单独设置。

Codecov 上传失败会保留失败日志，并在 Actions 中显示 warning 和任务摘要，不阻断 Mac 运行包交付。报告缺失、单元覆盖率未达标等工程问题仍会导致 CI 失败。启用服务后应检查实际上传结果，不能把整体 CI 绿色等同于 Codecov 已接通。

桌面与任务新增检查：`npm run test:desktop` 运行真实 Electron、独立 Node 服务和 `tests/fixtures/codex-task.mjs` App Server 协议替身。验证唯一静态/本机框架作品页面、MCP 点击重试不重复、输入、发布 localStorage 延续、交互终端界面、Diff 附件、OfflineAudioContext 中的真实 AudioWorklet PCM 帧、设备绑定向导入口、退出与重启。离线音频图不依赖 CI 声卡，不代表麦克风/扬声器真机通过。服务端另测 task 请求去重、线程恢复、审批/问题、中断、超时、MCP 鉴权和 SSE。替身不调用真实模型，不作为真实 Codex 或灵矽验收证据。

Mac 上 `npm run desktop:pack` 将随包 Node/npm 与服务放入 `.app`，打 ZIP，再从实际 ZIP 解压启动集成检查；兼容终端 tar 也会解压验证。原生页面与生命周期由这套进程检查覆盖；纯静态资产冻结逻辑另有真实文件系统测试，覆盖 Mac 路径别名、隐藏文件、symlink 逃逸与配额，并计入单元覆盖率。没有降低原覆盖率门槛。

新增测试覆盖常驻连接的乱序 RPC/独立失败/断开，排队与 steer、多个问题请求、Sidechat/Fork、PTY 生命周期；Git 在真实临时仓库中区分 staged/unstaged/untracked。灵矽通过本机真实 WebSocket 替身验证鉴权/PCM/草稿/设备 MCP/两类停止/上下文变化；OTA 使用受控 HTTP 响应验证六位码、激活 202/success/异常、私密凭证保存、取消、超大响应和不受信 URL，不向真实云注册测试设备。

后续补充：独立 worktree、区域截图、自动语音摘要、本地关键词与回声；真实 macOS 权限及系统投屏自动化。

真机验收单独记录麦克风距离、回声、多人发言、AirPlay 重连与大屏可读性。CI 不需要供应商密钥、麦克风和电视，也不把这些算作已验证。

当前受管环境的 CLI 0.163.0 可生成协议类型，但实际 App Server 因其默认 `/run/codex-environment/codex-home` 为只读而无法初始化 SQLite；未改写 HOME/CODEX_HOME 绕过。这里的真实执行证据仍限于受控 App Server 协议替身，实际 CLI 终端/模型需在 Mac 可写用户目录验收。

模型/上下文新增验证：完整可见模型分页不启动 thread/turn，列表失败/循环有界，最近请求与累计计数分离，早到和结束后报告、自动压缩下降、未知容量、跨线程/旧轮次过滤，以及独立元数据表的重启和旧 v2 schema 兼容。浏览器测选择器自动读取与错误重试；真实 Electron 验证 model/effort 进入实际任务参数和 25% 占用显示。所有模型/token 数据仍来自协议替身，不宣称真实账户计费已验收。

逐轮统计验证：两轮各含多次请求，重复通知不双计、排队与跨轮迟到报告不串用，重启保留各轮数据；缺报、fork 基线未知、累计重置和可选字段缺失不猜测。浏览器核对每轮不同命中率、SSE 迟到更新、零输入和中断提示；真实 Electron 核对回复下方的实际协议统计。运行与检查命令不变。

历史选段验证：浏览器使用真实 DOM Selection 选取消息段落，核对只引用该段、保留已写回复、不启动任务；选段 Sidechat 只 Fork 已结束轮次，将引用放入独立草稿，切回主对话或带回结论时保留各自文字和附件。服务端验证来源消息、文本与选中对话，拒绝伪造或过期来源。真实 Electron 检查选段浮层、草稿切换，以及菜单关闭时可见的 Token/上下文摘要；被动大屏同样验证摘要常显。协议数据来自替身，不证明真实模型计费、唤醒词或语音服务可用。

执行设置与工具目录验证：使用 CLI 0.163.0 的 `generate-ts --experimental` 核对正式 collaborationMode 和 approvalsReviewer 字段。协议替身覆盖空设置响应后的真实通知确认、默认/计划切换、排队时捕获权限、组织限制、确认失败不启动模型、自动审查拒绝及 Sidechat 强制只读；语音测试覆盖 STT 不改模式、主动收音内工具调用、去重及禁止语音提权。目录测试覆盖分页循环、只投影公开字段和部分失败；浏览器验证可读卡片、额度暂停与模式/权限选择。真实 Electron 验证独立临时验证入口和实际 turn 参数。

本轮实际启动系统 CLI 的尝试在 initialize 前因只读配置目录退出；官方类型生成成功，未修改 HOME/CODEX_HOME 绕过。真实 Plan 模型行为及自动审查后端仍需 Mac 登录后验收。在 App 展开「模式说明与兼容验证」并点击「验证执行设置」，可先做不请求模型执行的设置兼容检查；诊断 GET 仍不创建线程。
