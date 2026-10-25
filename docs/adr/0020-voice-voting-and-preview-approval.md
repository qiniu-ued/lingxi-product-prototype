# ADR 0020：语音投票与共享预览授权

- 日期：2026-10-25
- 状态：已实现；云端语音模型与麦克风链路需现场验证

语音投票复用设备端 `workbench_submit`，不增加本地 STT 自动执行或直接计票路径。共享角色说明和工具描述将“参与者2投给广西北海”等作品操作与改代码同等交给 Codex，完整保留身份、编号和目的地。Codex 先读取唯一预览，再操作已有控件并核对；不能改源码或直接写 localStorage 模拟投票，不能重投、猜测姓名编号或自动重置。未确认的身份通过既有问答解决，真实 taskId 仍只代表接收。

真实 CLI 0.164.0 验证发现 `mcpServer/elicitation/request` 被旧适配器当作未知请求拒绝，导致 `mcpToolCall` 显示 “user rejected MCP tool call”，即使用户根本未见授权界面。

仅支持应用自有 `lingxi_preview` 的空 `form` 工具确认：核对当前线程/轮次、`codex_approval_kind=mcp_tool_call`、严格解析的预览动作与当前绑定。复用现有批准面板和 Task 的 command 类型，不更改持久格式。批准/拒绝按官方 `action` 与空 `content` 响应；不持久授权，不自动接受，不扩展沙盒、网络或文件权限。其他服务器、URL、验证码、凭据及额外表单继续拒绝。只读 Sidechat 的 MCP 禁用保持不变。

单元覆盖语音转写本身不执行、明确工具调用传递完整投票指令、同次收音不能提交另一票；预览授权需真实决策，拒绝和非允许请求不提升权限。真实 Codex、真实 Electron、受控语音协议和七牛真实语音是分别记录的证据，不能相互替代。

协议依据：[OpenAI App Server](https://learn.chatgpt.com/docs/app-server) 的 MCP server elicitation；本机 CLI 生成 schema 与隔离任务的实际请求核对。当前 Manual 仍需电脑端批准，语音不能批准额外权限。

真实 CLI 的 `tools/call` 还带标准 `_meta`，只忽略这层传输元数据，不放宽动作校验。每次成功预览响应提供 `nextRequestId` UUID，模型复制用于下一动作，重试保留同一 ID，避免描述性字符串被动作边界拒绝。

2026-10-25 本机真实 Codex 0.164.0 / gpt-6.1-sol 与真实 Electron 隔离验收通过：逐次明确批准后，参与者1投广西北海，六次预览工具调用均完成，新快照与实际浏览器存储一致为 `[1,null,null,null,null,null]`、1/6 人，源文件 SHA-256 未变化。此证据不包含七牛真实语音识别，正式六票结果未用于测试。受控语音协议验证工具调用前不执行、调用后按原文交接，以及重复/过期上下文限制。
