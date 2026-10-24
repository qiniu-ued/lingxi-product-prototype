# 灵矽共创工作台

[![CI](https://github.com/qiniu-ued/lingxi-product-prototype/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/qiniu-ued/lingxi-product-prototype/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/qiniu-ued/lingxi-product-prototype/branch/main/graph/badge.svg)](https://app.codecov.io/gh/qiniu-ued/lingxi-product-prototype)

在沙发或会议室里提出想法，让 Codex 制作产品，大家在大屏上看进展、体验作品，再继续修改。目标支持七牛灵矽语音、鼠标点选和键盘输入。

当前分支提供 **Mac 桌面工作区、常驻 Codex 会话、交互终端、Diff、对话历史、Sidechat/Fork 与灵矽设备绑定向导**。采用 Electron + React + TypeScript + Node.js 24。灵矽 PCM 收音、转写、播报和设备 MCP 已实现协议适配，真实账号与 M1 Pro 音频尚待验收；自定义唤醒词和 AirPlay 自动配对未实现。设计师的原始演示保留在 `source/` 和根 `dist/`，其中语音和投屏仍是预设剧情。

## 在 Mac 使用

从 [Actions → CI](https://github.com/qiniu-ued/lingxi-product-prototype/actions/workflows/ci.yml) 对应 PR/提交的全部通过运行下载 `runtime-macos-15-<commit>`（Apple Silicon）或 `runtime-macos-15-intel-<commit>`。解开 artifact，再解开其中的 `Lingxi-0.1.0-darwin-arm64.zip` / `darwin-x64.zip`，将 `Lingxi.app` 拖到「应用程序」并打开。**桌面包内置 Node、npm 和本机服务，日常启动与退出不需要终端。**

当前是未签名、未公证的开发预览包，macOS 可能阻止首次打开；可信来源包的放行方式及校验见[部署文档](docs/deployment.md)。若组织策略禁止未签名应用，需等待签名版本。不要关闭全局 Gatekeeper。
1. 打开「连接向导」，一次查看 Codex 和灵矽检查结果；按需一键安装 stable latest Codex CLI，并在官方浏览器登录。仅有 Codex 桌面应用时仍需要 CLI。
2. 向导中获取灵矽六位绑定码，在官方控制台登录、创建智能体并绑定设备，点击「我已绑定，检查连接配置」。向导自动保存加密凭证；连接后测试收音与播报，无需编译音频客户端。
3. 新建或打开一个允许 Codex 修改的项目文件夹，输入本轮要求并提交。额外权限和问题在操作台处理，随时可停止任务。
4. 简单作品使用 `preview/index.html`，完成后自动发布。已有 React/Vite 等项目可在「终端」运行开发服务器，再在「预览 → 连接项目开发服务器」填写其 loopback 地址，例如 `http://127.0.0.1:5174/`。
5. 大屏窗口持有唯一的作品页面，电脑端显示它的实时截图。「点选修改」选择元素后输入要求；需要体验按钮和表单，可直接操作大屏窗口，也可要求 Codex 点击、输入或滚动。
6. AirPlay 暂由 macOS 控制中心连接。选择扩展显示后打开大屏，应用优先放到外接屏；需要时自行移动窗口。连接电视和系统 PIN 由 macOS 管理。
7. 关闭操作台窗口，或菜单「退出灵矽」，会停止应用启动的服务与任务。关闭大屏窗口只隐藏大屏，不取消任务。文件修改不会因停止任务而回退。

真实提供方登录、模型调用、M1 Pro 麦克风和电视仍需要本机验收；协议替身测试不算这些能力已验证。你可以在本机登录并绑定灵矽设备，无需向开发者发送密码或密钥。日常收音需主动点击，直接语音提交也携带收音开始时的鼠标标记、附件和键盘草稿；普通转写形成草稿；如需语音提交任务，在向导明确开启该选项。没有持续唤醒监听，未保存录音。

## 电脑端工作区

- 对话可新建、搜索标题、重命名、归档和切换，保留每轮消息与实际执行记录。执行中可排队或补充当前任务，提问显示选项并允许填写答案。
- 「终端」提供项目 PTY；选中输出可添加到对话。停止任务和结束终端分开，退出应用结束所有自有连接与终端。
- 「Diff」区分 Codex 本轮 patch、Git 已暂存和未暂存变更；选中行并填写评论，可加入下一条指令。
- 「点选修改」可保存多个版本化元素标记，再统一说明修改。上下文附件明确提交后才发给 Codex。
- 已结束轮次可创建只读 Sidechat，或 Fork 对话。Sidechat 可把结论带回原对话；普通 Fork 共享项目文件，尚未提供独立 Git worktree。
- 输入框上方自动加载模型与 Reasoning Effort，切换模型时调整为兼容强度。新选择用于后续提交，正在执行和已入队的轮次保留原选择。
- 「上下文」显示最近一次 Codex 报告的窗口占用；展开可查看输入、缓存读写、输出、推理及线程累计 token。未知容量/用量显示未报告，不把累计消耗当作当前占用。
- 每轮结束后，回复下方显示本轮总 token、输入/输出和缓存命中率（本轮缓存读取 ÷ 本轮输入），可展开明细。统计包含本轮多次模型请求，随迟到报告更新并持久保存；缺少基线/计数时明确提示，中断/失败显示截至最后报告的用量。
- 输入区「工作模式」选择执行／计划模式，使用官方 collaboration mode 协议。权限可选 Manual、Approve for me、Full Access；选项受 CLI 和组织策略约束，提交前等待 Codex 确认，新选择不改变已排队任务。Sidechat 始终只读。
- 点击「验证执行设置」，在独立临时会话验证模式和权限接口，不请求模型执行或修改项目。当前云环境的真实 CLI 启动仍受只读配置目录限制；正式接口接入已通过协议替身，真实 Mac 需要点击该按钮验收。
- 「工具与额度」按需展示 Skills 名称、说明与启用状态，MCP 连接、授权和工具列表，以及额度窗口、使用进度与重置时间；各部分可独立报告不可用。完整功能对照见 [工作区能力表](docs/workspace-capabilities.md)。
- 连接灵矽并开启语音控制后，可说“切换到计划模式”或“切换到执行模式”。由设备 MCP 调用同一模式命令，普通转写仍是草稿；权限级别只通过操作台选择。

## 从源码开发

需要 Node.js **24.x**、npm **11.x**：

```sh
npm ci
npm run desktop:dev
```

`desktop:dev` 编译后启动桌面应用；修改源码后退出并重新运行。纯浏览器基础模式使用 `npm run dev`，操作台 <http://127.0.0.1:5173/>、大屏 `/display`、向导 `/setup`，保留建议保存和同步功能。独立浏览器服务没有桌面预览控制，也不会执行 Codex 任务。

```sh
npm run check
npm run test:e2e
npm run test:desktop
npm run audit:production
# 在目标架构的 Mac 构建桌面 ZIP 与兼容的终端运行包
npm run desktop:pack
```

- [Mac 连接与验收指南](docs/mac-setup.md)
- [运行、打包、部署、更新与回退](docs/deployment.md)
- [开发与工程结构](docs/development.md)、[测试与 Codecov 配置](docs/testing.md)
- [产品设计](docs/product-design.md)、[系统架构](docs/architecture.md)、[桌面与预览 ADR](docs/adr/0003-desktop-canonical-preview.md)、[常驻会话与灵矽 ADR](docs/adr/0004-persistent-workspace-and-voice.md)、[模型与上下文 ADR](docs/adr/0005-model-controls-and-context-usage.md)
- [设计对齐、唤醒词与自动投屏计划](docs/desktop-voice-plan.md)、[实施清单](docs/roadmap.md)

覆盖率徽章展示主分支数据；私有仓库需要在 Codecov 侧启用服务，CI 绿色不代表外部上传成功。
