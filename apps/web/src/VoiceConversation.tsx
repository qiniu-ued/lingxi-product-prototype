import { type VoiceTurn, voiceConversationSchema } from '@lingxi/protocol';
import { useEffect, useRef, useState } from 'react';

export function useVoiceConversation() {
  const operation = useRef(0);
  const [state, setState] = useState({ revision: 0, turns: [] as VoiceTurn[] });
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true,
      pending = false,
      etag = '';
    const update = async () => {
      if (pending) return;
      pending = true;
      const epoch = operation.current;
      try {
        const response = await fetch('/api/voice/conversation', {
          headers: etag ? { 'If-None-Match': etag } : {},
        });
        if (response.status === 304) return;
        if (!response.ok) throw new Error();
        const next = voiceConversationSchema.parse(await response.json());
        if (active && epoch === operation.current) {
          etag = response.headers.get('etag') ?? '';
          setState(next);
          setError('');
        }
      } catch {
        if (active && epoch === operation.current) setError('语音记录暂时无法同步。');
      } finally {
        pending = false;
      }
    };
    void update();
    const timer = setInterval(() => void update(), 700);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function clear() {
    const epoch = ++operation.current;
    try {
      const response = await fetch('/api/voice/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear' }),
      });
      if (!response.ok) throw new Error();
      const next = voiceConversationSchema.parse(await response.json());
      if (epoch === operation.current) {
        setState(next);
        setError('');
      }
    } catch {
      setError('语音记录未能清除，请重试。');
    }
  }
  return { ...state, error, clear };
}
const taskLabels: Record<NonNullable<VoiceTurn['taskStatus']>, string> = {
  queued: '已排队',
  starting: 'Codex 正在准备',
  running: 'Codex 执行中',
  waiting: 'Codex 等待确认/回答',
  stopping: '正在停止',
  completed: 'Codex 本轮已结束',
  failed: 'Codex 执行失败',
  interrupted: 'Codex 已停止',
};
export function VoiceTurns({
  turns,
  prompt,
  messageIds,
  showOutcome = true,
}: {
  turns: VoiceTurn[];
  prompt?: string;
  messageIds?: string[];
  showOutcome?: boolean;
}) {
  return (
    <>
      {turns.map((turn) => (
        <section
          className="voice-chat-turn"
          key={turn.id}
          data-voice-turn={turn.id}
          aria-label="语音对话轮次"
        >
          {turn.messages
            .filter(
              (message) =>
                (!messageIds || messageIds.includes(message.id)) &&
                !(message.role === 'user' && prompt?.trim() === message.text.trim()),
            )
            .map((message) => (
              <div className={`chat-row ${message.role === 'user' ? 'user' : ''}`} key={message.id}>
                <span className="chat-avatar" aria-hidden="true">
                  {message.role === 'user' ? '发' : '语'}
                </span>
                <div className="chat-message">
                  <span className="bubble-speaker">
                    {message.role === 'user' ? '发言人 · 语音' : '丽塔同学 · 语音回复'}
                    {message.state === 'streaming'
                      ? ' · 接收中'
                      : message.state === 'interrupted'
                        ? ' · 已中断'
                        : ''}
                  </span>
                  <div className="live-bubble" data-voice-message={message.id}>
                    {message.text || '正在接收语音回复…'}
                  </div>
                </div>
              </div>
            ))}
          {showOutcome && (
            <p className="voice-turn-outcome" role="status">
              {turn.taskStatus
                ? taskLabels[turn.taskStatus]
                : turn.handoff?.status === 'submitted'
                  ? '已交给 Codex'
                  : turn.handoff?.status === 'blocked'
                    ? '工作台未接受操作'
                    : turn.handoff?.status === 'unhandled'
                      ? '本轮未提交 Codex'
                      : turn.handoff?.status === 'handled'
                        ? '工作台工具已返回结果'
                        : '等待工作台工具调用；语音回复不代表已执行'}
              {turn.handoff?.taskId && (
                <a href={`#codex-turn-${turn.handoff.taskId}`}>
                  {' '}
                  · 任务 {turn.handoff.taskId.slice(0, 8)}
                </a>
              )}
            </p>
          )}
          {showOutcome && turn.handoff && !turn.handoff.taskId && (
            <small className="voice-turn-detail">{turn.handoff.message}</small>
          )}
        </section>
      ))}
    </>
  );
}
