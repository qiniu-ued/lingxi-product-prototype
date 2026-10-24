# ADR 0004：常驻 Codex 工作区与灵矽设备绑定

日期：2026-10-24。状态：本分支实施，真实账号与 M1 Pro 音频仍待验收。延续 ADR 0003 的本机 Electron / Node 分工。

## Codex 会话与输入

每个当前项目拥有一个常驻 App Server stdio 连接。使用递增 RPC ID 分发响应；单次 RPC 出错不关闭其他请求，丢失连接不自动重放。每轮结束保留连接，退出/切换项目清理连接拥有的 PTY。诊断仍使用独立短连接，不创建线程。

本机对话 ID 与 Codex thread ID 分开；对话包含轮次、真实消息、执行记录、计划、patch 和多个待回答请求。新对话、重命名、归档、切换历史、普通 fork 和只读 Sidechat 均为显式操作。目前同一项目一次运行一个模型轮次。失败或停止会暂停排队输入；静态发布完成后才放行下一轮，避免冻结文件与下一轮写入竞争。Sidechat 从已结束轮次 fork；文件系统 read-only、审批 never，并禁用发现的 MCP 服务。发现失败则不创建 Sidechat。普通 Fork 复制对话上下文，共享项目文件；尚未实现独立 Git worktree，界面明确告知。

键盘和灵矽 MCP 使用同一个 Workbench。执行中可排队，或通过 `turn/steer` 指定 expectedTurnId 追加；持久化队列在重启后标为中断，不自行执行。审批按真实 RPC 请求分别保存；问题保留标题、选项、自由输入与敏感标记。秘密回答只发给对应 RPC，不加入普通聊天历史。

Add to conversation 是输入草稿附件。终端选区、diff 评论、多个浏览器元素标记和文字/代码片段在明确提交时进入 UserInput，而非仅保存 UI 标签。浏览器标记必须匹配当前 preview binding；任意 DOM 不保证可映射到源码。区域截图、原生文件浏览器、官方浏览器 Annotation API 仍未实现。

## 终端、Diff 与预览

终端回放仅留在当前进程的有限缓存；明确添加到对话的输出才持久保存。xterm.js 通过固定的 `command/exec` PTY API 连接应用选择的登录 shell；不向 HTTP 接受可执行文件或 argv。用户主动在终端输入的 stdin 是有意的终端操作。该接口仅桌面能力可用，需要合法本机 Origin；不通过灵矽或预览 MCP 暴露 shell。正常停止轮次不关闭终端；连接无响应时有界关闭整个连接，终端标为失败。

Codex 本轮 diff 与 Git 已暂存/未暂存 diff 分开展示。Git 使用固定 execFile argv，禁用外部 diff/textconv；未跟踪文件仅列名称，不自动读取。没有自动回滚/暂存/提交。

静态冻结预览保留。用户可在项目终端启动框架 dev server，然后明确绑定 HTTP loopback URL。大屏仍持有唯一 WebContentsView，操作台和模型仍操作同一页。只放行选定服务的精确 origin 及对应 WebSocket；禁止绑定工作台服务端口，禁止生成页面访问工作台 API、Node 和 IPC。外部 CDN/API、任意远程页面未放开。实时 HMR 下 binding 表示项目/页面/导航，非每次 DOM 改变的源码快照；操作前重新 snapshot，消失的节点 ref 会被拒绝。

## 灵矽：绑定与音频

使用官方 [OTA 网关](https://linx.qiniu.com/docs/xrobot/platform/OTA) 注册设备、获取六位激活码，在官方控制台完成账号登录与授权，再通过 `/v1/ota/activate` 检查；成功后再次 OTA 获取 WebSocket URL/token。Mac 生成稳定的本地管理伪 MAC 与 UUID（官方协议允许），不伪装 ESP32、不读取 Wi-Fi 名称、不下载响应中的固件。用户不需要复制令牌；保留高级手动配置入口。

身份文件 `voice-device.json` 是非秘密标识；凭证由 Electron safeStorage 加密存为 `voice-config.enc`。Node 服务仅经私有 IPC 读写，HTTP/SSE/日志不返回令牌。系统加密不可用时失败，不降级明文。不同系统账号/设备恢复时可能需要重新绑定。

Node 主动建立官方 WSS，携带 Device-Id、Client-Id、Protocol-Version 与鉴权头。按照 [WebSocket 协议](https://linx.qiniu.com/docs/xrobot/platform/websocket) 协商 PCM16LE / 16kHz / 单声道 / 20ms；可信操作台 AudioWorklet 从麦克风采集，私有 IPC 传定长帧；TTS PCM 经同一路径播放。本版不解码 Opus，协商不符明确失败。没有额外 C++ helper 或 Homebrew 依赖。

收音由点击启动，60 秒上限；普通讨论不监听、不上传、不存录音。STT 只形成草稿。用户可额外启用设备 MCP 提交/停止，限主动收音及结束后 30 秒，固定当前项目与对话，一次收音最多一条任务，稳定 capture ID 进入 Workbench 持久去重。云端不能通过此通道批准权限或执行任意 shell。设备 MCP 的 WS envelope 与 Codex 的 HTTP 预览 MCP 是两个方向不同的通道。

`listen.detect.text_response` 用于明确点击的测试播报，`abort` 仅停止声音。已基于真实状态合并播报结束、失败和提问信息；语义摘要、语音回答工具和本地“丽塔同学”唤醒尚待后续；转写可填入问题回答。AirPlay 由 macOS 手动处理。

## 存储兼容与验证边界

新增 `workspace_state_v2` / `workspace_turns_v2`，首次从 v1 最近任务与请求回执导入；原 `session`、`workbench_state`、`workbench_requests` 不改写。HTTP schemaVersion=1 保留兼容信封，新字段有默认值。旧程序忽略 v2；降级后产生的 v1 新修改不会再次导入，回退应用不能当作数据库回滚。

RPC 契约参考本地 CLI 0.163.0 生成的 v2 类型。安装仍使用 stable latest；不将官方桌面全部 UI 功能视为现成的 CLI API。模型、Skills、MCP 和额度按独立能力读取，失败不掩盖其他结果；“先给计划并请求确认”目前是指令约束，非官方 collaboration Plan mode。

单元/API/真实子进程替身、Electron 页面与音频帧测试验证实现契约。真实账户激活、PCM 协商、听说质量、模型调用、macOS 麦克风与 AirPlay 均必须另记真机证据。
