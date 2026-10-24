import {
  type VoiceDiagnostics as DiagnosticState,
  type VoiceDiagnosticEvent,
  voiceDiagnosticsSchema,
} from '@lingxi/protocol';
import { useEffect, useRef, useState } from 'react';

const labels: Record<VoiceDiagnosticEvent['kind'], string> = {
  'service-connecting': '开始连接服务',
  'service-ready': '语音握手成功',
  'service-disconnected': '服务断开',
  'service-failed': '连接失败',
  'capture-started': '新一轮收音已绑定上下文',
  'capture-ended': '会话收音停止',
  'asr-received': '收到语音转写',
  'asr-discarded': '丢弃过期/失效转写',
  'tools-discovered': '云端读取工具列表',
  'tool-called': '收到工具调用',
  'tool-rejected': '工具调用被拒绝',
  'tool-returned': '工具已返回结果',
  'rpc-replayed': '重复请求/冲突',
  'handoff-missing': '本轮播报结束，未提交任务',
  'task-submitted': '已获得 Codex 任务回执',
  'task-status': 'Codex 任务状态',
  'assistant-start': '开始播报',
  'assistant-sentence': '收到播报文字',
  'assistant-stop': '播报结束',
  'protocol-rejected': '协议消息未接受',
};
const reasons: Record<string, string> = {
  voice_submit_disabled: '未开启语音执行',
  capture_required: '没有有效收音',
  capture_expired: '收音窗口已过期',
  voice_context_changed: '项目/对话已变化',
  project_required: '尚未选择项目',
  task_running: '已有任务在执行',
  selection_stale: '点选目标已变化',
  capture_already_submitted: '本轮已提交其他要求',
  mode_change_pending: '模式切换尚未完成',
  invalid_arguments: '工具参数无效',
  unsupported_tool: '不支持的工具',
  operation_rejected: '操作未接受',
  invalid_rpc: '无效的工具协议消息',
  unsupported_method: '不支持的协议方法',
  duplicate_request: '重复请求，未重复执行',
  request_conflict: '请求编号冲突',
  authentication_failed: '设备认证失败',
  network_failure: '网络/连接失败',
  handshake_timeout: '服务握手超时',
  protocol_incompatible: '音频或协议不兼容',
  audio_unavailable: '音频不可用',
  no_tool_call: '未调用提交工具',
  tts_out_of_order: '播报片段顺序无效，已忽略',
};
export function VoiceDiagnostics() {
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef(0),
    mutating = useRef(false);
  const [saving, setSaving] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [manualCopy, setManualCopy] = useState('');
  const [readAt, setReadAt] = useState('');
  const [open, setOpen] = useState(false),
    [state, setState] = useState<DiagnosticState | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    const update = async () => {
      if (mutating.current) return;
      const epoch = operation.current;
      try {
        const response = await fetch('/api/voice/diagnostics');
        if (!response.ok) throw new Error();
        const value = voiceDiagnosticsSchema.parse(await response.json());
        if (active && epoch === operation.current) {
          setReadAt(new Date().toISOString());
          setState(value);
          setSyncError('');
        }
      } catch {
        if (active && epoch === operation.current)
          setSyncError('无法读取最新诊断，下方为上次结果；请检查本机服务。');
      }
    };
    void update();
    const timer = setInterval(() => void update(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);
  async function command(value: { action: 'enabled'; enabled: boolean } | { action: 'clear' }) {
    const epoch = ++operation.current;
    mutating.current = true;
    setSaving(true);
    try {
      const response = await fetch('/api/voice/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error();
      const next = voiceDiagnosticsSchema.parse(await response.json());
      if (epoch === operation.current) {
        setState(next);
        setReadAt(new Date().toISOString());
        setNotice('');
        setManualCopy('');
        setError('');
      }
    } catch {
      setError('诊断操作未完成，请重试。');
    } finally {
      mutating.current = false;
      setSaving(false);
    }
  }
  return (
    <>
      <button
        type="button"
        onClick={() => {
          dialog.current?.showModal();
          setOpen(true);
        }}
      >
        语音诊断
      </button>
      <dialog
        ref={dialog}
        className="voice-diagnostics-dialog"
        onClose={() => setOpen(false)}
        aria-label="语音交接诊断"
      >
        <header>
          <h2>语音交接诊断</h2>
          <button type="button" onClick={() => dialog.current?.close()}>
            关闭诊断
          </button>
        </header>
        <p>
          仅在内存保留最近 128 条、30
          分钟的阶段记录。开关仅本次运行有效；退出清除，重启默认记录脱敏阶段。不含音频、转写正文、提示内容或令牌。
        </p>
        {state && (
          <>
            <dl className="voice-diagnostic-snapshot">
              <div>
                <dt>项目</dt>
                <dd>{state.snapshot.projectSelected ? '已选择' : '未选择，不能执行开发任务'}</dd>
              </div>
              <div>
                <dt>语音执行</dt>
                <dd>{state.snapshot.voiceSubmitEnabled ? '已开启' : '未开启'}</dd>
              </div>
              <div>
                <dt>工具发现</dt>
                <dd>{state.snapshot.toolsListed ? '已读取列表（不代表调用）' : '尚未读取'}</dd>
              </div>
              <div>
                <dt>收音绑定</dt>
                <dd>{state.snapshot.captureActive ? '当前窗口有效' : '尚无有效窗口'}</dd>
              </div>
            </dl>
            <div className="live-actions">
              <label>
                <input
                  type="checkbox"
                  checked={state.enabled}
                  disabled={saving}
                  onChange={(event) =>
                    void command({ action: 'enabled', enabled: event.target.checked })
                  }
                />
                记录脱敏诊断
              </label>
              <button
                type="button"
                disabled={saving}
                onClick={() => void command({ action: 'clear' })}
              >
                清空诊断
              </button>
              <button
                type="button"
                onClick={async () => {
                  setNotice('');
                  setError('');
                  const value = [
                    '丽塔同学语音诊断 v1',
                    `应用版本: ${state.build.version}; commit=${state.build.commit ?? 'unknown'}${state.build.dirty ? '+local' : ''}; builtAt=${state.build.builtAt ?? 'unknown'}`,
                    `导出时间: ${new Date().toISOString()} (UTC); 本地时区: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
                    `读取时间: ${readAt || 'unknown'} (UTC)`,
                    `保留范围: 仅内存，最近 ${state.capacity} 条 / ${state.retentionMinutes} 分钟；重启清空。`,
                    `Snapshot: ${JSON.stringify(state.snapshot)}`,
                    `Enabled: ${state.enabled}; dropped: ${state.dropped}; events: ${state.events.length}`,
                    ...state.events.map(
                      (event) =>
                        `#${event.sequence} ${event.at} ${event.kind} session=${event.sessionId ?? '-'} capture=${event.captureId ?? '-'} project=${event.projectId ?? '-'} conversation=${event.conversationId ?? '-'} task=${event.taskId ?? '-'} tool=${event.tool ?? '-'} code=${event.code ?? '-'} status=${event.status ?? '-'} characters=${event.characters ?? '-'}`,
                    ),
                  ].join('\n');
                  try {
                    if (window.lingxiDesktop) await window.lingxiDesktop.copy(value);
                    else await navigator.clipboard.writeText(value);
                    setManualCopy('');
                    setNotice('已复制诊断日志，不包含语音正文。');
                  } catch {
                    setManualCopy(value);
                    setError('无法自动复制，请在下方文本框全选后复制。');
                  }
                }}
              >
                复制诊断日志
              </button>
            </div>
            {!!state.dropped && (
              <p>
                旧记录已轮转或过期 {state.dropped} 条，当前保留 {state.events.length} 条。
              </p>
            )}
            {!state.events.length ? (
              <p>尚无阶段记录。开始一轮语音后可在这里检查；读取工具列表不会被记作任务提交。</p>
            ) : (
              <ol className="voice-diagnostic-events">
                {state.events.map((event) => (
                  <li key={event.sequence}>
                    <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time>{' '}
                    <strong>{labels[event.kind]}</strong>
                    {event.tool && <span> · {event.tool}</span>}
                    {event.code && <span> · {reasons[event.code] ?? '操作未接受'}</span>}
                    {event.status && <span> · {event.status}</span>}
                    <small
                      title={`session=${event.sessionId ?? '-'} capture=${event.captureId ?? '-'} task=${event.taskId ?? '-'}`}
                    >
                      {event.captureId ? ` 本轮 ${event.captureId.slice(0, 8)}` : ''}
                      {event.taskId ? ` 任务 ${event.taskId.slice(0, 8)}` : ''}
                    </small>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
        {manualCopy && (
          <label>
            诊断日志文本（可手动复制）
            <textarea
              readOnly
              rows={8}
              value={manualCopy}
              onFocus={(event) => event.target.select()}
            />
          </label>
        )}
        {notice && <p role="status">{notice}</p>}
        {(error || syncError) && <p role="alert">{error || syncError}</p>}
      </dialog>
    </>
  );
}
