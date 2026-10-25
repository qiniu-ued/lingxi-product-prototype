# ADR 0015：空闲远端会话的静默恢复

状态：采用，2026-10-25。补充 ADR 0013，并取代此前所有收到 goodbye 后均播放告别、等待远端关闭的策略。

## 证据与范围

用户曾在真实 Mac 日志中观察到 goodbye → 告别 TTS → close 1006 → 约 1.6 秒重连。控制台显示空闲 3600 秒，但该轮末次状态播报后约 122 秒即收到 goodbye，尚不能确认该连接的实际生效配置或服务端结束原因。本次再次听到告别时 Mac 已锁屏，未取得新日志，不能断言两次根因相同。

核对官方文档及公开客户端：
- [智能体空闲设置](https://linx.qiniu.com/docs/xrobot/guide/agent-config#idle-timeout)与[智能体 API](https://linx.qiniu.com/docs/xrobot/api/agent)将 `extra.goodbye.idle_timeout_seconds` 限制为 60–3600 秒，页面初始值 120 秒，判断还考虑会话音频活动；退出意图与空闲设置独立。文档未提供永不结束或客户端关闭此策略的参数。
- [WebSocket 协议](https://linx.qiniu.com/docs/xrobot/platform/websocket)的 manual/auto/realtime 控制收音方式。manual 的 listen stop 结束当句话，不是应用的全局关闭。当前应用用原生 ws 适配协议，未使用额外的语音 SDK；每 20 秒 ping、45 秒 pong watchdog 验证传输，不能据此保证业务空闲计时重置。不能为保活发送虚假 listen detect/用户文字/音频，也不改成持续上传的 realtime。
- [官方文档指向的客户端示例](https://github.com/sunqirui1987/linx-linux/blob/main/demo/linx.cc)也将 goodbye 当成会话结束；它不是云端服务源码，不能证明云端超时实现。
- [智能体切换协议](https://linx.qiniu.com/docs/xrobot/platform/agent-voice-switch)允许 X-Agent-ID 指定智能体。当前应用未显式设置该头，依赖已有设备绑定；这不证明绑定错误。本次不新增该配置、不换智能体、不修改账户或云端参数。后续核验应比较绑定默认智能体、已保存配置和重连后的实际行为。

本地核验的官方文档仓库版本为 `qiniu/Xrobot-docs@20ce1b29a1bdff575a4c3317689bae30a7e08535`；线上资料后续可能更新。

## 决定

仅在收到当前连接的明确 goodbye 后处理，不能凭静音计时、告别文案或普通 tts stop 推断远端结束。

若没有待回应的新语音请求，立即退役该连接、清空排队播放和当前收音上下文，阻止随后旧连接的告别 TTS/PCM。继续记录 goodbye 和本机清理来源，再使用既有 1/2/4/8/16/30 秒、最多六次的退避重连。诊断写 remote_session_end、source=app、reason=remote_goodbye，另记录 local close；未观察到远端 close 就不编造关闭码或网络故障。界面如实显示服务重连/失败/暂停，与本地待唤醒分开。

协议没有可靠的用户主动告别原因字段，因此采用保守边界：当前 capture 仍在既有有效窗口且作用域相符，或普通用户回复仍在播放时，保留回复并等待远端关闭。该边界使用应用已有上下文和有效期，不新增静音断连超时，不根据 STT 文字自动执行关闭。此时仍可能听到告别，不能保证过滤所有非用户请求的告别；没有 goodbye 前兆的音频也保持原样。

已经运行且获授权的本地唤醒继续工作；未运行的唤醒不会因恢复连接而开启。重连只恢复服务，清除旧 capture、speechId、draft、上传与待播报，不重放任务、不恢复云端收音，不产生假语音。已接受的任务/回执保留，Codex 继续执行。手动断开、语音关闭工具、全局关闭、休眠和退出均优先，取消恢复且不改变原有权限要求。

这是跨远端会话恢复连续可用的策略，不是让同一云端会话无限存活，也不修复尚未知的服务端告别触发原因。无数据格式、凭据、模型、云端配置或部署方式变更。

## 验证

使用真实本机 WebSocket 替身覆盖空闲 goodbye 后排队的 TTS/PCM 被阻断、已有播放清理、本地唤醒保留且无音频上行、首次重连成功但无旧 capture/任务重放、新收音可提交、不同 session 的 goodbye 被忽略、显式关闭取消重试、连续快速 goodbye 耗尽预算，以及新用户请求/正在播放的普通回复保留。既有任务及结果关联、静音保活、缺 pong、认证失败和退出清理继续回归。

运行项目 check、浏览器与真实 Linux Electron 检查；它们验证本地行为，不等于七牛真实 goodbye 或 Mac 扬声器/麦克风验收。真实复现需用户解锁后通过 UI 复制含新版本的详细诊断，不绕过锁屏，不要求为本次研究返回电脑。
