# ADR 0005：输入区模型选择与真实上下文用量

日期：2026-10-24。状态：本分支实施。协议依据是 Codex CLI 0.163.0 生成的 `ModelListResponse`、`ThreadSettingsUpdatedNotification`、`ThreadTokenUsageUpdatedNotification` 与 `ThreadTokenUsage`。

## 选择器

模型与 Reasoning Effort 放在操作台输入框上方，选择项目后自动读取 `GET /api/workbench/models`。本机服务只查询 model/list，不创建线程或执行轮次；读取完整分页、过滤 hidden、拒绝循环游标和超大目录。列表失败保留已保存选择，允许显式刷新，不硬编码模型名或用假列表代替。

强度来自所选模型的 supportedReasoningEfforts；切换模型时使用它所报告的兼容默认强度，缺失则沿用 Codex 设置。当前版本不认识的强度不伪装为受支持。沿用项表示不覆盖现有线程/CLI 设置，不等于强制恢复某个模型默认值。

设置沿用已有全局后续提交偏好。每轮在提交/入队时捕获 settings，执行中的任务和已排队任务不会被后来的修改改变。thread/start、resume、fork 返回值及 thread/settings/updated 单独保存 Codex 确认的线程配置；该配置不是逐轮模型执行遥测，不能将请求的选择直接当作模型已执行的证明。

## 上下文统计

- 接收 thread/tokenUsage/updated，保留最近一次模型请求 last、线程累计 total、模型窗口 modelContextWindow、对应 turnId 与上报时间。
- 占用率为 last.totalTokens / modelContextWindow；剩余量为 max(0, window - last.totalTokens)。累计消耗不能用作当前占用。图形最多填满，但文字仍保留超出容量的真实比例。
- 明细分列最近请求与线程累计，包含总量、输入、缓存读取/写入、输出、推理。缓存计数属于输入子项，推理属于输出子项，不重复相加。
- 没有用量报告或窗口容量未知/为零时，不显示假 0%、猜测容量或估算草稿。缺失的可选计数显示“未报告”。没有逐条系统提示/文件/工具的 token 归因，也不声称有。
- 在开始响应前到达的事件缓冲到已知 turnId；完成之后到达的用量仍处理。忽略未知线程、旧轮次和非法计数；允许自动压缩后最近请求用量下降。不同对话、项目和 fork 不共用统计。
- 大屏只展示简洁占用信息，操作台可展开明细。恢复的数据是“上次报告”，不是新调用或实时草稿估算。

## 存储与兼容

新增 `workspace_thread_runtime_v1`，以本机 conversationId 保存确认配置和用量，并绑定 Codex thread ID。HTTP 快照新增有默认值的 runtime 字段；写回旧 workspace_state_v2 时明确移除该字段，原 Task/Conversation 格式不增加属性。旧版本的严格 schema 因此仍可读取自己的快照，新表会被旧版本忽略。

升级无需重写旧数据，初始统计未知；降级不删除统计，但不会刷新它。再次升级校验 Codex thread ID，一致时保留上报时间，不一致时拒绝套用旧统计。表中不保存凭据、原始提供方错误或模型上下文正文。

## 验证

受控 App Server peer 验证模型分页/失败、线程确认配置、早到/迟到用量、压缩下降、错误/跨线程/旧轮次过滤与重启恢复；真实 SQLite 验证旧快照兼容。浏览器测试验证选项、失败重试和未知容量，真实 Electron 验证选择最终进入任务、用量显示与既有预览/终端功能。它们不能代替用户账户的真实模型和计费验收。
