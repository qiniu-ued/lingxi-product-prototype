import { type VoiceDebugState, voiceDebugSchema } from '@lingxi/protocol';
import { useEffect, useRef, useState } from 'react';

export function VoiceDebug() {
  const epoch = useRef(0),
    mutating = useRef(false);
  const [state, setState] = useState<VoiceDebugState | null>(null);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const [syncError, setSyncError] = useState(''),
    [notice, setNotice] = useState('');
  const [manual, setManual] = useState('');
  useEffect(() => {
    let active = true;
    const read = async () => {
      if (mutating.current) return;
      const current = epoch.current;
      try {
        const response = await fetch('/api/voice/debug');
        if (!response.ok) throw new Error();
        const value = voiceDebugSchema.parse(await response.json());
        if (active && current === epoch.current) {
          setState(value);
          setSyncError('');
        }
      } catch {
        if (active && current === epoch.current) setSyncError('无法读取详细调试状态。');
      }
    };
    void read();
    const timer = setInterval(() => void read(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function clear() {
    const current = ++epoch.current;
    mutating.current = true;
    setSaving(true);
    setNotice('');
    setError('');
    setManual('');
    try {
      const response = await fetch('/api/voice/debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear' }),
      });
      if (!response.ok) throw new Error();
      const value = voiceDebugSchema.parse(await response.json());
      if (current === epoch.current) setState(value);
    } catch {
      setError('未能清空详细调试，请重试。');
    } finally {
      mutating.current = false;
      setSaving(false);
    }
  }
  const content = state
    ? [
        '丽塔同学详细调试 v1 — 含对话和项目内容，分享前请检查',
        '以下为经过凭据脱敏的详细 payload，不是未经修改的原始网络包。不包含二进制音频。',
        `应用版本: ${state.build.version}; commit=${state.build.commit ?? 'unknown'}${state.build.dirty ? '+local' : ''}; builtAt=${state.build.builtAt ?? 'unknown'}`,
        `导出时间: ${new Date().toISOString()} (UTC); 本地时区: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
        `保留: 应用运行时持续记录，${state.capacity} 条 / ${state.retentionMinutes} 分钟，每条最多 ${state.maxPayloadCharacters} 字符；退出清空。`,
        `Enabled: ${state.enabled}; dropped: ${state.dropped}; events: ${state.events.length}`,
        ...state.events.map(
          (event) =>
            `#${event.sequence} ${event.at} ${event.direction}/${event.event} session=${event.sessionId ?? '-'} capture=${event.captureId ?? '-'} project=${event.projectId ?? '-'} conversation=${event.conversationId ?? '-'} task=${event.taskId ?? '-'} truncated=${event.truncated}\n${event.payload}`,
        ),
      ].join('\n')
    : '';
  return (
    <section aria-label="详细语音调试" className="voice-debug">
      <h3>详细调试日志（自动记录）</h3>
      <p>
        应用运行时自动记录转写原文、助手文字、工具参数与返回结构，包含对话和项目内容；凭据始终遮盖，不录音、不落盘、不上传。分享前请预览检查。
      </p>
      <p>
        仅本次运行有效：最多 64 条 / 10 分钟，每条 8192
        字符；超限注明截断。退出清空；清空或关闭面板不会停止记录，不能补回旧版本省略的原文。
      </p>
      {state && (
        <>
          <p>
            详细调试持续记录 · 保留 {state.events.length} 条 · 已轮转或过期 {state.dropped} 条
          </p>
          {state.events.some((event) => event.truncated) && (
            <p>部分 payload 已截断，标记 truncated=true。</p>
          )}
          <details>
            <summary>预览详细日志（含对话内容）</summary>
            <textarea
              readOnly
              rows={8}
              aria-label="详细调试日志预览（含对话内容）"
              value={content}
            />
          </details>
          <div className="live-actions">
            <button type="button" disabled={saving} onClick={() => void clear()}>
              清空详细调试
            </button>
            <button
              type="button"
              onClick={async () => {
                setNotice('');
                setError('');
                try {
                  if (window.lingxiDesktop) await window.lingxiDesktop.copy(content);
                  else await navigator.clipboard.writeText(content);
                  setManual('');
                  setNotice('已复制详细日志，包含对话内容；分享前请检查。');
                } catch {
                  setManual(content);
                  setError('无法自动复制详细日志，请在下方文本框全选后复制。');
                }
              }}
            >
              复制详细日志（含对话内容）
            </button>
          </div>
        </>
      )}
      {manual && (
        <label>
          详细日志文本（可手动复制）
          <textarea readOnly rows={8} value={manual} onFocus={(event) => event.target.select()} />
        </label>
      )}
      {notice && <p role="status">{notice}</p>}
      {(error || syncError) && <p role="alert">{error || syncError}</p>}
    </section>
  );
}
