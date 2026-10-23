# 集成边界

## Codex

本机 Node 服务管理 `codex app-server` 子进程，通过 stdio JSON-RPC 通信。浏览器提交任务到本地服务；本机使用已有 Codex 登录，项目路径明确指定。

用户安装使用稳定通道 `@latest`，检查报告实际版本并验证握手。本分支参照 CLI 0.163.0 生成的 App Server v2 类型，并通过子进程协议替身验证消息契约；真实模型调用另做验收。已实现初始化、线程创建/恢复、开始、审批与中断。真实文件变更、计划、命令及任务终结事件更新画面，询问和审批沿用 Codex 设置。任务完成与页面可用、测试通过分别验证。

当前提供 `AgentAdapter` 接口与只读环境检查：`/setup` 先汇总 Codex 与灵矽的可检测状态，再展示配置步骤。Codex 可检测 CLI、App Server 握手和认证配置；检查后关闭进程，不创建线程或执行任务。用户另行点击才会在工作台工具目录安装 latest CLI 或通过官方网页登录。灵矽检测尚未实现，明确显示暂无法检测。桌面版已实现创建/恢复线程、提交、审批/问题、中断和事件展示，不自动接管 Codex 桌面应用已有会话。静态作品与专用 MCP 见 [ADR 0003](adr/0003-desktop-canonical-preview.md)。尚未实现执行中追加要求或任意项目 dev server。首次安装与检查限制见 [Mac 连接指南](mac-setup.md)。

参考：[App Server](https://developers.openai.com/codex/app-server/)。

## 七牛灵矽 AI

官方有 macOS 音频客户端，可与工作台和 Codex 同机运行。客户端采音/播报，七牛云端提供语音能力。适配器管理录音、转写、播放和打断；部分转写只进入草稿，最终提交进入统一会话。

优先验证端侧工具通道：Mac 主动连接灵矽，注册提交、查询、停止工具，长任务先返回任务 ID 后异步执行。若使用第三方业务回调，需要云端可达服务及到 Mac 的连接；不能用本机 `localhost` 作为云端回调地址。

当前 `VoiceAdapter` 只有边界接口，无采音、联网或密钥。首版从按键激活开始，唤醒词、远场麦克风、电视回声、重叠发言和异步播报均需真机验证。

参考：[macOS 客户端](https://linx.qiniu.com/docs/xrobot/guide/client-demo)、[端侧 MCP](https://linx.qiniu.com/docs/xrobot/mcp/hardware-mcp)、[业务接入](https://linx.qiniu.com/docs/xrobot/guide/third-app)。

## AirPlay

首版用户在 macOS 连接电视并选扩展显示，把 `/display` 窗口移过去。网页连接正常不代表电视已接收 AirPlay，不能混用状态。屏幕发现、语音配对和自动连接留待系统能力验证。

参考：[Apple AirPlay](https://support.apple.com/en-ie/guide/mac-help/mchld7e543a0/mac)。

## A2UI

适合动态选择卡、配置表单和待决定事项。固定外壳、执行状态、预览和元素选择由工作台完成。暂不增加依赖；接入时固定协议版本、组件目录、动作映射及契约测试。

参考：[A2UI 介绍](https://a2ui.org/introduction/what-is-a2ui/)。

自定义唤醒词、原生免终端启动与系统投屏自动化的边界和阶段安排见 [设计对齐计划](desktop-voice-plan.md)。
