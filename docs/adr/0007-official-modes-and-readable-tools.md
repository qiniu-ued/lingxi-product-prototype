# ADR 0007：正式协作模式、权限与可读工具目录

日期：2026-10-24。状态：本分支实施。

## 协议依据与证据

从本机 CLI 0.163.0 运行 `codex app-server generate-ts --experimental --out <临时目录>`，确认 `collaborationMode/list`、`thread/settings/update`、`turn/start.collaborationMode`、`ApprovalsReviewer` 和组织要求字段。普通类型生成会隐藏实验字段，不能据此认定 Plan 不受支持。

早期受限环境中的真实 App Server 启动尝试在 initialize 前因配置目录只读退出；SQLite/log 路径覆盖也没有解决启动限制，未修改 HOME/CODEX_HOME。后续于 2026-10-24 在 Mac 上使用 CLI 0.164.0 验证本节的隐含 cwd 兼容修复：原 Hello World 项目切换到 GPT-5.6-Sol 后真实只读检查 completed，随后正式 Plan 轮次生成计划并 completed；线程回执及会话记录确认模型和 default/plan，项目文件 SHA-256 前后一致。上述真机证据不代表自动审查后端已验收，受控通知和 Electron 协议测试也不能替代真实模型证据。

## 模式与确认

输入区用执行/计划选择器替换工具页的提示词开关。沿用 settings.plan 的存储与提交时捕获行为，将其映射到官方 default/plan。`collaborationMode.settings` 提交真实模型、推理强度及 `developer_instructions:null`，使用 Codex 内置指令；不拼接“先给计划”文字。每轮显式发送 default，使退出 Plan 的行为明确。

GET 只查询模式与组织要求。提交模型任务之前发送 thread/settings/update；其成功响应是空对象，不能当成设置已确认。等待匹配线程且模式、模型/强度、审批策略/审查者以及所有请求的沙箱字段一致的 thread/settings/updated。通知可早于响应到达；超时、不支持或不一致就结束该任务，不发送 turn/start。真实 turn/start 再携带同一组设置。

用户显式点击「验证执行设置」才启动独立短连接，在临时工作目录创建 ephemeral 会话并检查模式、权限通知，禁用发现的 MCP，期间不发送 turn/start，不改变操作台选中项目/会话。完成、失败和退出应用均关闭该子进程并清理临时目录。界面只把收到一致通知的项目标为已验证。该操作与连接向导的只读诊断分开。

实机 CLI 0.164.0 会从 `workspaceWrite.writableRoots` 回执省略隐含可写的当前目录。设置请求现在显式携带项目 `cwd`，先确认回执的工作目录与项目目录一致，再比较“当前目录 + 显式根目录”的规范路径集合。只兼容当前目录省略、重复、顺序及符号链接别名；额外根目录、缺少其他请求目录、无法解析的路径及不同 cwd 仍拒绝。沙箱类型、网络、临时目录开关、审批策略/审查者、模式与模型/强度继续逐项确认，响应为空或未收到匹配通知不能放行。

## 权限

选择器由本产品实现，Codex 提供底层协议，不提供可直接嵌入的 React UI。

| 选项              | 沙箱                     | 审批策略   | 审查者      |
| ----------------- | ------------------------ | ---------- | ----------- |
| Manual（默认）    | workspaceWrite，网络关闭 | on-request | user        |
| Approve for me    | workspaceWrite，网络关闭 | on-request | auto_review |
| Full Access       | dangerFullAccess         | never      | user        |
| Sidechat 固定覆盖 | readOnly，网络关闭       | never      | user        |

自动审查由 Codex 实际执行，可批准、拒绝、超时或取消；应用展示 item/autoApprovalReview 通知，不能通过收到请求后一律 accept 模拟此模式。组织策略不允许的选择不可用，发起任务时再次检查并要求确认。完整访问不承诺跳过额外安全控制。计划模式使用官方任务行为指令，权限仍是独立维度；Sidechat 继续禁用所有发现的 MCP/插件。

权限偏好与 task UUID 对应的提交/排队快照存入新表 workspace_permissions_v1。HTTP 增加有默认值的 permission 字段，但写旧 workspace_state_v2 时剥离；Task/Conversation JSON 不增加字段。旧版本忽略新表；升级默认 Manual 或恢复此前显式选择，修改不影响正在运行或已排队任务。

## 语音

设备 MCP 增加 workbench_set_mode，仅接收 plan/default。沿用主动收音、显式语音控制授权、有效 capture ID、项目/会话目标及去重机制，调用同一个工作区模式命令。异步能力检查后重新验证 capture/目标/时限；已经提交任务后不能借同次收音改变该任务，一次收音只允许一种模式。普通 STT 不执行命令；没有语音权限升级工具。切换成功后播报真实结果。

## 工具与额度

服务校验 Skills、MCP、额度各自的响应，并投影到专门的共享 schema，不把任意配置对象直接给页面。MCP 读取完整有界分页，拒绝循环游标。只显示技能名称/说明/启用/来源、MCP 连接/授权/工具说明/资源数、额度进度/重置/余额。未知状态保留未知，各类失败独立呈现；去掉账户标识、提供方配置、令牌和原始错误。普通额度是否可用只采用提供方 ordinaryUsageAllowed，不能由使用百分比推断恢复。目录保持只读，不伪装具备安装、OAuth 或配置编辑能力。

运行、打包、部署命令与现有 Node/Electron 结构不变。验证层次见 testing.md，用户入口见 mac-setup.md。
