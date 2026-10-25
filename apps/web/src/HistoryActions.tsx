import { type HistoryQuote, historyQuoteSchema, type WorkbenchState } from '@lingxi/protocol';
import { MessageSquare, Quote, X } from 'lucide-react';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ConfigurationButton } from './ConfigurationControls';

export function HistoryActions({
  state,
  transcript,
  busy,
  running,
  attachmentsFull,
  onSelect,
  onQuote,
  onSidechat,
  onReturn,
}: {
  state: WorkbenchState;
  transcript: RefObject<HTMLDivElement | null>;
  busy: boolean;
  running: boolean;
  attachmentsFull: boolean;
  onSelect: () => void;
  onQuote: (quote: HistoryQuote) => void;
  onSidechat: (quote: HistoryQuote) => void;
  onReturn?: (quote: HistoryQuote) => void;
}) {
  const [selection, setSelection] = useState<{
    quote: HistoryQuote;
    context: string;
    rect: { left: number; right: number; top: number; bottom: number };
  } | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const latest = useRef(state);
  latest.current = state;
  const selected = useRef(onSelect);
  selected.current = onSelect;
  const toolbar = useRef<HTMLDivElement>(null);
  const context = `${state.project?.id}:${state.selectedThreadId}`;
  useLayoutEffect(() => {
    if (!selection || !toolbar.current) return;
    const bounds = transcript.current?.getBoundingClientRect();
    const left = Math.max(8, bounds?.left ?? 8);
    const right = Math.min(innerWidth - 8, bounds?.right ?? innerWidth - 8);
    toolbar.current.style.maxWidth = `${right - left}px`;
    const { width, height } = toolbar.current.getBoundingClientRect();
    const { rect } = selection;
    const above = rect.top - height - 8;
    setPosition({
      left: Math.max(left, Math.min((rect.left + rect.right - width) / 2, right - width)),
      top: Math.max(8, Math.min(above >= 8 ? above : rect.bottom + 8, innerHeight - height - 8)),
    });
  }, [selection, transcript]);
  useEffect(() => {
    setSelection(null);
    const pick = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key === 'Escape') return;
      if (toolbar.current?.contains(event.target as Node)) return;
      const range = window.getSelection();
      const node = range?.anchorNode;
      const element = node instanceof Element ? node : node?.parentElement;
      const bubble = element?.closest<HTMLElement>('[data-history-task]');
      if (
        !range?.rangeCount ||
        range.isCollapsed ||
        !range.focusNode ||
        !bubble ||
        !transcript.current?.contains(bubble) ||
        !bubble.contains(range.focusNode)
      ) {
        setSelection(null);
        return;
      }
      const parsed = historyQuoteSchema.safeParse({
        taskId: bubble.dataset.historyTask,
        role: bubble.dataset.historyRole,
        messageId: bubble.dataset.historyMessage,
        text: range.toString(),
      });
      if (!parsed.success) {
        setSelection(null);
        return;
      }
      const current = latest.current;
      const task = current.history.find((task) => task.id === parsed.data.taskId);
      if (
        !current.project ||
        !current.selectedThreadId ||
        task?.conversationId !== current.selectedThreadId
      ) {
        setSelection(null);
        return;
      }
      const rect = range.getRangeAt(0).getBoundingClientRect();
      const bounds = transcript.current.getBoundingClientRect();
      selected.current();
      setSelection({
        context,
        quote: parsed.data,
        rect: {
          left: rect.left,
          right: rect.right,
          top: Math.max(rect.top, bounds.top),
          bottom: Math.min(rect.bottom, bounds.bottom),
        },
      });
    };
    const dismiss = (event: MouseEvent) => {
      if (
        !toolbar.current?.contains(event.target as Node) &&
        !transcript.current?.contains(event.target as Node)
      )
        setSelection(null);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelection(null);
    };
    const hide = () => setSelection(null);
    const area = transcript.current;
    document.addEventListener('mouseup', pick);
    document.addEventListener('keyup', pick);
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', dismissOnEscape);
    area?.addEventListener('scroll', hide);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('mouseup', pick);
      document.removeEventListener('keyup', pick);
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', dismissOnEscape);
      area?.removeEventListener('scroll', hide);
      window.removeEventListener('resize', hide);
    };
  }, [context, transcript]);
  if (!selection || selection.context !== context) return null;
  const task = state.history.find((task) => task.id === selection.quote.taskId);
  const canDiscuss =
    !!task?.turnId && ['completed', 'failed', 'interrupted'].includes(task.status) && !running;
  return (
    <div
      className="history-actions history-actions-compact"
      ref={toolbar}
      role="toolbar"
      aria-label="所选对话文字操作"
      style={position}
      onMouseDown={(event) => event.preventDefault()}
    >
      <ConfigurationButton
        type="button"
        variant="ghost"
        className="history-action"
        aria-label="引用到对话"
        disabled={busy || attachmentsFull}
        title={attachmentsFull ? '请先移除部分上下文附件' : '引用所选段落并撰写回复'}
        onClick={() => {
          onQuote(selection.quote);
          setSelection(null);
        }}
      >
        <Quote aria-hidden="true" />
        引用
      </ConfigurationButton>
      <ConfigurationButton
        type="button"
        variant="ghost"
        className="history-action"
        aria-label="选段 Sidechat"
        disabled={busy || !canDiscuss}
        title={canDiscuss ? '基于该轮创建只读讨论，所选段落加入草稿' : '请等待当前任务结束'}
        onClick={() => {
          onSidechat(selection.quote);
          setSelection(null);
        }}
      >
        <MessageSquare aria-hidden="true" />
        Sidechat
      </ConfigurationButton>
      {onReturn && (
        <ConfigurationButton
          type="button"
          variant="ghost"
          className="history-action"
          disabled={busy || running}
          onClick={() => {
            onReturn(selection.quote);
            setSelection(null);
          }}
        >
          <Quote aria-hidden="true" />
          引用到原对话
        </ConfigurationButton>
      )}
      <ConfigurationButton
        type="button"
        variant="ghost"
        className="history-action history-action-close"
        aria-label="关闭选段操作"
        onClick={() => setSelection(null)}
      >
        <X aria-hidden="true" />
      </ConfigurationButton>
    </div>
  );
}
