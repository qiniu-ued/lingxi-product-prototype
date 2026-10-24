import type { VoiceState } from '@lingxi/protocol';
import { SettingsLink } from './Navigation';

export function VoiceHandoff({
  state,
  showSettings = true,
}: {
  state: VoiceState | null;
  showSettings?: boolean;
}) {
  if (!state?.configured) return null;
  return (
    <section className="voice-handoff" aria-label="语音交接状态">
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
      {!state.allowVoiceSubmit && showSettings && (
        <SettingsLink section="lingxi" label="开启语音执行" />
      )}
    </section>
  );
}
