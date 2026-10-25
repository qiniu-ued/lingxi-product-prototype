import type { VoiceState } from '@lingxi/protocol';
import { ChevronDown } from 'lucide-react';
import { SettingsLink } from './Navigation';
import { VoiceDiagnostics } from './VoiceDiagnostics';

export function VoiceHandoff({
  state,
  showSettings = true,
  compact = false,
  onOpen,
}: {
  state: VoiceState | null;
  showSettings?: boolean;
  compact?: boolean;
  onOpen?: () => void;
}) {
  if (!state?.configured) return null;
  const blocked = state.handoff?.status === 'blocked' || state.handoff?.status === 'unhandled';
  const summary =
    state.status === 'failed'
      ? '连接异常'
      : state.status === 'disconnected'
        ? '未连接'
        : state.status === 'connecting'
          ? '连接中'
          : blocked
            ? '未交给 Codex'
            : state.handoff?.status === 'awaiting-tool'
              ? '等待交接'
              : !state.allowVoiceSubmit || state.handoff?.status === 'draft-only'
                ? '仅转写'
                : state.handoff?.status === 'submitted' && state.handoff.taskId
                  ? '已交给 Codex'
                  : state.deviceToolsReady
                    ? '语音执行已开启'
                    : '已连接';
  const content = (
    <>
      <strong>{state.allowVoiceSubmit ? '语音执行已开启' : '仅转写草稿 · 语音执行未开启'}</strong>
      {!['disconnected', 'failed'].includes(state.status) && (
        <small>
          {state.deviceToolsReady
            ? '丽塔同学已读取工作台工具列表'
            : '尚未收到丽塔同学的工作台工具发现请求'}
        </small>
      )}
      {state.handoff && (
        <p>
          最近一次语音：
          {state.handoff.message}
          {state.handoff.taskId && <small>任务 {state.handoff.taskId.slice(0, 8)}</small>}
        </p>
      )}
      {showSettings && <VoiceDiagnostics />}
      {!state.allowVoiceSubmit && showSettings && (
        <SettingsLink section="lingxi" label="开启语音执行" />
      )}
    </>
  );
  return (
    <section
      className={`voice-handoff${compact ? ' voice-handoff-compact' : ''}${compact && (blocked || state.status === 'failed') ? ' has-issue' : ''}`}
      aria-label="语音交接状态"
    >
      {compact ? (
        <details
          className="voice-handoff-menu"
          open={blocked || state.status === 'failed'}
          onToggle={(event) => {
            if (event.currentTarget.open) onOpen?.();
          }}
        >
          <summary>
            <strong className="voice-handoff-state">{summary}</strong>
            <ChevronDown className="voice-handoff-chevron" aria-hidden="true" />
          </summary>
          <div className="voice-handoff-details">
            {content}
            {state.error && <p role="alert">{state.error}</p>}
          </div>
        </details>
      ) : (
        content
      )}
    </section>
  );
}
