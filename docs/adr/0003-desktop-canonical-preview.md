# ADR 0003：Mac 桌面入口与唯一作品页面

- 日期：2026-10-23
- 状态：本分支实现；真实提供方与 Mac 设备验收待完成

## 背景

用户需要不经过终端启动/停止应用。浏览器不能直接执行本机 Codex 或管理 macOS 投屏。会议中“给金山投一票”既可能是作品操作，也可能是修改代码；Codex 必须看到并操作大家正在看的同一个页面。

## 决定

使用 Electron 作为 Mac 应用容器，保留 React UI、Node 24 服务和 SQLite。Electron 主进程通过私有 IPC 管理独立 Node 子进程，打包 Node 24 和 npm 11；SQLite 使用 Node ABI，不在 Electron 中加载。单实例锁防止重复服务；菜单退出或关闭操作台触发有界的子进程清理，父进程意外断开时服务也关闭。数据目录独立于安装目录。

大屏窗口中的一个 `WebContentsView` 持有作品，电脑端显示该页面截图。生成页面不载入工作台 preload，不具备 Node、IPC、麦克风或系统权限。预览使用每项目独立的持久 session 和稳定 `lingxi-preview://<projectId>/index.html` 来源，保留 localStorage。

第一版只发布项目 `preview/` 内允许的静态网页资产，不运行项目 dev server。发布前冻结副本，限制文件类型、数量、总大小，拒绝 symlink；不提供项目根目录或隐藏文件。页面网络请求被阻止，暂不支持 CDN、外部 API、嵌入框架、跨站登录或任意网站。文件内容未变时不刷新页面；有变化才发布新版本。旧快照保留，未提供自动清理或版本回退 UI。

Codex 任务通过 App Server 的 `thread/start` / `thread/resume`、`turn/start`、真实事件、审批和 `turn/interrupt` 实现；工作目录为用户选择的项目，使用 `workspace-write` / `on-request`。不接管 Codex 桌面应用的会话。不把环境诊断、保存建议或前端定时器当作执行完成。首次契约参考本环境 CLI 0.163.0 生成的 v2 类型；安装仍使用 stable latest，真实版本可在向导查看。新 CLI 协议变化可能需要适配。

向任务配置本机 HTTP MCP `lingxi_preview`，令牌每次启动随机生成，仅通过子进程环境传递。只提供截图/文本快照、click、type、scroll 固定动作，不提供任意 JS、浏览器 RPC、可执行文件或 shell 接口。动作携带项目、页面 UUID、发布版本、导航 epoch 和元素 ref；变更后旧目标失效。动作 requestId 在当前页面中去重，派发后抓图失败也不会自动重复点击。Agent 需重新快照核对结果。鼠标选中同一个页面中的元素，但不会触发它的点击事件；指令附带版本和 ref，版本失效时拒绝提交。

## 数据与兼容

SQLite 会话协议仍为 schemaVersion 1。增加 `workbench_state` 和 `workbench_requests` 两表，原 `session` 表不变。状态更新与任务请求回执在事务内保存；任务 ID 跨重启去重，冲突内容不会执行。当前只在 UI 展示最近一轮，历史回执保留以阻止重复执行。重启后未结束任务标为 interrupted，用户核对已有文件修改后继续，绝不自动重放。

旧版本忽略新增表，但无法展示新任务。回退不删表或降级数据；停止服务后备份整个数据目录及 WAL。Codex 修改的项目文件和浏览器状态不会随服务回退自动恢复。

## 后续

灵矽音频与本地唤醒检测另做适配；“唤醒回复”开关不能证明支持自定义唤醒词。AirPlay 先手动连接，桌面应用可摆放窗口，不伪造连接/PIN 状态。自动点击系统投屏菜单需 Accessibility/可能的 Automation 授权和系统版本验证，不能仅用媒体 AirPlay picker 替代。

不引入 A2UI 作为预览控制层；其声明式 UI 可在以后用于确认卡片，不替代 Codex、浏览器实例或 macOS 投屏能力。
