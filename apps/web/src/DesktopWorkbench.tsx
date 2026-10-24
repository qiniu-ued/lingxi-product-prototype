import {
  type ContextAttachment,
  type HistoryQuote,
  type PreviewSnapshot,
  previewSnapshotSchema,
  type VoiceState,
  voiceStateSchema,
  type WorkbenchState,
  workbenchSchema,
} from '@lingxi/protocol';
import { type FormEvent, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ContextUsage } from './ContextUsage';
import { DiffPanel } from './DiffPanel';
import { ExecutionControls } from './ExecutionControls';
import { HistoryActions } from './HistoryActions';
import { MicrophoneIcon } from './MicrophoneIcon';
import { ModelControls } from './ModelControls';
import { SettingsLink, SetupLink } from './Navigation';
import { TurnUsage } from './TurnUsage';
import { composerTarget, useComposerDraft } from './useComposerDraft';
import { VoiceControls } from './VoiceControls';
import { VoiceHandoff } from './VoiceHandoff';
import { WorkspaceTools } from './WorkspaceTools';

const TerminalPanel = lazy(() =>
  import('./TerminalPanel').then((module) => ({ default: module.TerminalPanel })),
);

// The prototype uses Lucide Sparkles; its license is retained in public/licenses/LUCIDE-LICENSE.
function SparklesIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4M22 5h-4M4 17v2M5 18H3" />
    </svg>
  );
}

export function DesktopWorkbench({ active = true }: { active?: boolean }) {
  const display = location.pathname === '/display';
  const [state, setState] = useState<WorkbenchState | null>(null),
    [connected, setConnected] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [shot, setShot] = useState<PreviewSnapshot | null>(null),
    [answers, setAnswers] = useState<Record<string, string>>({}),
    [displayVoice, setDisplayVoice] = useState<VoiceState | null>(null);
  const transcript = useRef<HTMLDivElement>(null),
    followTranscript = useRef(true),
    workspaceMenu = useRef<HTMLDetailsElement>(null),
    composer = useRef<HTMLDetailsElement>(null);
  const viewport = useRef<HTMLDivElement>(null),
    retry = useRef<{ text: string; id: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [runtimeUrl, setRuntimeUrl] = useState('http://127.0.0.1:5174/');
  const [tab, setTab] = useState('preview');
  const [mode, setMode] = useState<'queue' | 'steer'>('queue'),
    [search, setSearch] = useState(''),
    [rename, setRename] = useState('');
  const target = composerTarget(state);
  const retryTarget = useRef(target);
  const {
    text,
    annotation,
    setAnnotation,
    setText,
    attachments,
    setAttachments,
    selection,
    setSelection,
    voiceDraft,
    setVoiceDraft,
    patch: patchDraft,
  } = useComposerDraft(target);
  const composedText = [
    text.trim(),
    selection && annotation.trim() ? `元素批注：${annotation.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const latestState = useRef(state);
  latestState.current = state;
  const lastVoice = useRef('');
  const receiveVoice = useCallback(
    (text: string, id: string) => {
      const key = `${id}:${text}`;
      if (lastVoice.current === key) return;
      lastVoice.current = key;
      setVoiceDraft({ text, id });
    },
    [setVoiceDraft],
  );
  const bindingKey = state?.preview ? JSON.stringify(state.preview) : '';
  const thread = state?.threads.find((t) => t.id === state.selectedThreadId);
  function attach(value: ContextAttachment) {
    if (composer.current) composer.current.open = true;
    setAttachments((old) => (old.length < 20 ? [...old, value] : old));
    retry.current = null;
  }
  function focusComposer() {
    if (composer.current) composer.current.open = true;
    requestAnimationFrame(() => document.getElementById('task-prompt')?.focus());
  }
  function quoteAttachment(quote: HistoryQuote): ContextAttachment | null {
    const current = latestState.current;
    const source = current?.history.find((task) => task.id === quote.taskId);
    if (!source || source.conversationId !== current?.selectedThreadId) return null;
    const original =
      quote.role === 'user'
        ? quote.messageId === 'prompt'
          ? source.prompt
          : undefined
        : source.messages.find((message) => message.id === quote.messageId)?.text;
    if (!original?.includes(quote.text)) return null;
    const ordinal = (current?.history.findIndex((task) => task.id === source.id) ?? 0) + 1;
    return {
      id: crypto.randomUUID(),
      kind: 'text',
      title: `引用 · ${quote.role === 'user' ? '发言人' : 'Codex'} · 第 ${ordinal} 轮`,
      text: `引用原文：\n${quote.text}\n\n来源：${thread?.title ?? '当前对话'}，第 ${ordinal} 轮。`,
    };
  }
  function quoteToDraft(quote: HistoryQuote) {
    const attachment = quoteAttachment(quote);
    if (!attachment) {
      setError('引用来源已变化，请重新选择文字。');
      return;
    }
    attach(attachment);
    focusComposer();
  }
  async function discussQuote(quote: HistoryQuote) {
    const attachment = quoteAttachment(quote);
    const source = latestState.current;
    if (!attachment || !source?.project) {
      setError('引用来源已变化，请重新选择文字。');
      return;
    }
    await operate(
      'workspace',
      { action: 'fork', taskId: quote.taskId, kind: 'sidechat', quote },
      (next) => {
        const child = next.threads.find((thread) => thread.id === next.selectedThreadId);
        const current = latestState.current;
        if (
          current?.project?.id !== source.project?.id ||
          child?.parentId !== source.selectedThreadId ||
          (current?.selectedThreadId !== source.selectedThreadId &&
            current?.selectedThreadId !== child?.id)
        )
          throw new Error('quote_context_changed');
        patchDraft(composerTarget(next), (draft) => ({
          attachments: [...draft.attachments, attachment].slice(0, 20),
        }));
        focusComposer();
      },
    );
  }
  async function returnQuote(quote: HistoryQuote) {
    const attachment = quoteAttachment(quote);
    const parentId = thread?.parentId;
    if (!attachment || !parentId) return;
    await operate('workspace', { action: 'select-thread', id: parentId }, (next) => {
      if (next.selectedThreadId !== parentId) throw new Error('quote_context_changed');
      patchDraft(composerTarget(next), (draft) => ({
        attachments: [...draft.attachments, attachment].slice(0, 20),
      }));
      focusComposer();
    });
  }
  useEffect(() => {
    if (retryTarget.current !== target) {
      retry.current = null;
      retryTarget.current = target;
      followTranscript.current = true;
    }
  }, [target]);
  useEffect(() => {
    const events = new EventSource('/api/workbench/events');
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.addEventListener('workbench.snapshot', (event: MessageEvent<string>) => {
      try {
        const value = workbenchSchema.parse(JSON.parse(event.data));
        setState((old) => (!old || value.revision >= old.revision ? value : old));
      } catch {
        /* Keep last valid state. */
      }
    });
    return () => events.close();
  }, []);
  useEffect(() => {
    if (!display) return;
    let active = true;
    const update = async () => {
      try {
        const response = await fetch('/api/voice', { cache: 'no-store' });
        if (!response.ok) throw new Error('voice_state_unavailable');
        const value = voiceStateSchema.parse(await response.json());
        if (active) setDisplayVoice(value);
      } catch {
        if (active) setDisplayVoice(null);
      }
    };
    void update();
    const timer = setInterval(() => void update(), 700);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [display]);
  useEffect(() => {
    const element = viewport.current;
    if (!display || !element || !bindingKey) return;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      window.lingxiDesktop?.bounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.max(1, Math.floor(bounds.width)),
        height: Math.max(1, Math.floor(bounds.height)),
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [display, bindingKey]);
  useEffect(() => {
    if (display || !bindingKey) {
      setShot(null);
      return;
    }
    let active = true;
    const update = async () => {
      try {
        const value = await window.lingxiDesktop?.snapshot();
        if (active && value) setShot(previewSnapshotSchema.parse(value));
      } catch {
        /* Preview may be changing. */
      }
    };
    void update();
    const timer = setInterval(() => void update(), 1200);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [display, bindingKey]);
  useEffect(() => {
    if (!state?.revision) return;
    const node = transcript.current;
    if (node && (display || followTranscript.current)) node.scrollTop = node.scrollHeight;
  }, [display, state?.revision]);
  const staleSelection =
    (!!selection && JSON.stringify(selection.binding) !== JSON.stringify(state?.preview)) ||
    attachments.some(
      (a) => a.selection && JSON.stringify(a.selection.binding) !== JSON.stringify(state?.preview),
    );
  const task = state?.task,
    running = !!task && !['completed', 'failed', 'interrupted'].includes(task.status);
  async function operate(operation: string, body: unknown, after?: (next: WorkbenchState) => void) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/workbench/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error();
      const next = workbenchSchema.parse(await response.json());
      setState((old) => (!old || next.revision >= old.revision ? next : old));
      after?.(next);
      return true;
    } catch {
      setError('操作未完成，输入已保留。请检查连接、当前任务和连接向导后重试。');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function contextDetails(open: boolean) {
    try {
      const response = await fetch('/api/voice/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'context-details', open }),
      });
      if (!response.ok) throw new Error();
      setDisplayVoice(voiceStateSchema.parse(await response.json()));
    } catch {
      setError('上下文详情切换失败，请检查本机连接。');
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const draft = composedText;
    if (!draft) return;
    if (draft.length > 4000) {
      setError('本轮指令与元素批注合计最多 4,000 字符，请缩短后提交。');
      return;
    }
    if (retry.current?.text !== draft) retry.current = { text: draft, id: crypto.randomUUID() };
    if (
      await operate('start', {
        requestId: retry.current.id,
        text: draft,
        ...(selection ? { selection } : {}),
        attachments,
        mode: running ? mode : 'start',
      })
    ) {
      if (composer.current) composer.current.open = false;
      setText('');
      setAnnotation('');
      setAttachments([]);
      setVoiceDraft(null);
      setSelection(null);
      retry.current = null;
    }
  }
  return (
    <div className={`live-workbench ${display ? 'live-display' : ''}`}>
      <header className="live-header">
        <a href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            <SparklesIcon />
          </span>
          <span>
            丽塔同学
            <small role="status">
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="18" height="13" rx="2" />
                <path d="M8 21h8M12 16v5" />
              </svg>
              {connected ? '本机服务已连接' : '正在重连本机服务'}
            </small>
          </span>
        </a>
        <div className="live-actions">
          <span className={`task-state task-state-${task?.status ?? 'idle'}`}>
            {task
              ? {
                  queued: '等待执行',
                  starting: '正在准备',
                  running: '正在开发',
                  waiting: '等待确认',
                  stopping: '正在停止',
                  completed: '已完成',
                  failed: '执行失败',
                  interrupted: '已停止',
                }[task.status]
              : '等待需求'}
          </span>
          {!display && <SettingsLink />}
          {!display && (
            <details className="workbench-menu" ref={workspaceMenu}>
              <summary>工作区</summary>
              <div className="workbench-menu-content">
                <div className="live-actions">
                  <button
                    type="button"
                    onClick={() => void operate('action', { action: 'open-display' })}
                  >
                    打开大屏
                  </button>
                  {state?.preview && (
                    <button
                      type="button"
                      onClick={() => {
                        setTab('preview');
                        setPicking((value) => !value);
                        retry.current = null;
                        if (workspaceMenu.current) workspaceMenu.current.open = false;
                      }}
                    >
                      {picking ? '取消点选' : '点选修改'}
                    </button>
                  )}
                  <SetupLink />
                </div>
                {!display && (
                  <nav className="project-actions">
                    <button
                      type="button"
                      disabled={running || busy}
                      onClick={() => void operate('action', { action: 'new-project' })}
                    >
                      新建项目
                    </button>
                    <button
                      type="button"
                      disabled={running || busy}
                      onClick={() => void operate('action', { action: 'select-project' })}
                    >
                      打开项目
                    </button>
                    <span title={state?.project?.path}>
                      {state?.project?.name ?? '选择一个项目'}
                    </span>
                    {state?.project && (
                      <button
                        type="button"
                        disabled={running || busy}
                        onClick={() => void operate('action', { action: 'publish-preview' })}
                      >
                        刷新作品
                      </button>
                    )}
                  </nav>
                )}
                {!display && state?.project && (
                  <section className="conversation-bar">
                    <input
                      aria-label="搜索对话"
                      placeholder="搜索对话"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <select
                      aria-label="切换对话"
                      disabled={running || busy}
                      value={state.selectedThreadId ?? ''}
                      onChange={(e) => {
                        void operate('workspace', { action: 'select-thread', id: e.target.value });
                      }}
                    >
                      <option value="" disabled>
                        选择对话
                      </option>
                      {state.threads
                        .filter(
                          (t) =>
                            t.projectId === state.project?.id &&
                            !t.archived &&
                            t.title.toLowerCase().includes(search.toLowerCase()),
                        )
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.kind === 'sidechat'
                              ? 'Sidechat · '
                              : t.kind === 'fork'
                                ? 'Fork · '
                                : ''}
                            {t.title}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      disabled={running || busy}
                      onClick={() =>
                        void operate('workspace', { action: 'new-thread', title: '新对话' })
                      }
                    >
                      新对话
                    </button>
                    <input
                      aria-label="对话名称"
                      placeholder={thread?.title ?? '对话名称'}
                      value={rename}
                      onChange={(e) => setRename(e.target.value)}
                    />
                    <button
                      type="button"
                      disabled={!thread || !rename.trim() || running}
                      onClick={() => {
                        void operate('workspace', {
                          action: 'rename-thread',
                          id: thread?.id,
                          title: rename.trim(),
                        });
                        setRename('');
                      }}
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      disabled={!thread || running}
                      onClick={() =>
                        void operate('workspace', {
                          action: 'archive-thread',
                          id: thread?.id,
                          archived: !thread?.archived,
                        })
                      }
                    >
                      {thread?.archived ? '恢复对话' : '归档'}
                    </button>
                    <details>
                      <summary>已归档</summary>
                      {state.threads
                        .filter((t) => t.projectId === state.project?.id && t.archived)
                        .map((t) => (
                          <button
                            type="button"
                            key={t.id}
                            disabled={running}
                            onClick={() =>
                              void operate('workspace', { action: 'select-thread', id: t.id })
                            }
                          >
                            {t.title}
                          </button>
                        ))}
                    </details>
                  </section>
                )}

                {!display && (
                  <nav className="workspace-tabs" aria-label="项目工作区">
                    {[
                      ['preview', '预览'],
                      ['terminal', '终端'],
                      ['diff', 'Diff'],
                      ['tools', '工具与额度'],
                    ].map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        aria-pressed={tab === value}
                        onClick={() => {
                          setTab(value ?? 'preview');
                          if (workspaceMenu.current) workspaceMenu.current.open = false;
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </nav>
                )}
                {!display && tab === 'preview' && (
                  <details>
                    <summary>连接项目开发服务器</summary>
                    <p>
                      先在终端启动项目（如 npm run dev -- --port 5174），再连接其本机地址。大屏和
                      Codex 会使用同一页面。
                    </p>
                    <input
                      aria-label="项目预览地址"
                      value={runtimeUrl}
                      onChange={(e) => setRuntimeUrl(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        if (await operate('preview-url', { url: runtimeUrl })) {
                          if (workspaceMenu.current) workspaceMenu.current.open = false;
                        }
                      }}
                    >
                      连接预览
                    </button>
                  </details>
                )}
              </div>
            </details>
          )}
        </div>
      </header>
      <main className="live-grid">
        <section className="live-preview live-panel">
          {!display && state && tab === 'terminal' && (
            <Suspense fallback={<p>正在打开终端…</p>}>
              <TerminalPanel state={state} attach={attach} />
            </Suspense>
          )}
          {!display && tab === 'diff' && (
            <DiffPanel
              diff={state?.task?.diff ?? ''}
              projectId={state?.project?.id}
              attach={attach}
            />
          )}
          {!display && state && tab === 'tools' && (
            <WorkspaceTools state={state} operate={operate} attach={attach} />
          )}
          <div
            className="preview-surface"
            style={{ display: display || tab === 'preview' ? 'flex' : 'none' }}
          >
            <div className="live-heading">
              <h1>项目预览</h1>
              {!display && state?.preview && (
                <button
                  type="button"
                  aria-pressed={picking}
                  onClick={() => {
                    setPicking((value) => !value);
                    retry.current = null;
                  }}
                >
                  {picking ? '取消批注点选' : '批注修改'}
                </button>
              )}
            </div>
            {!display && picking && (
              <p role="status">点击预览中的元素，选中后填写修改要求；点选不会触发页面按钮。</p>
            )}
            <div ref={viewport} className="live-viewport" data-testid="canonical-viewport">
              {!state?.preview ? (
                <div className="live-empty">
                  <SparklesIcon />
                  <h2>聊聊你的想法吧。</h2>
                </div>
              ) : !display && shot ? (
                <button
                  type="button"
                  className={`preview-pick ${picking ? 'picking' : ''}`}
                  aria-label="选择预览元素"
                  disabled={!picking}
                  onClick={async (event) => {
                    const image = event.currentTarget.querySelector('img');
                    if (!image) return;
                    const rect = image.getBoundingClientRect();
                    try {
                      const value = await window.lingxiDesktop?.pick({
                        binding: shot.binding,
                        x: (event.clientX - rect.x) / rect.width,
                        y: (event.clientY - rect.y) / rect.height,
                      });
                      if (value) {
                        setSelection(value);
                        if (composer.current) composer.current.open = true;
                        setPicking(false);
                        retry.current = null;
                      }
                    } catch {
                      setError('预览已变化，请重新点选。');
                    }
                  }}
                >
                  <img
                    alt="大屏中同一个作品页面的实时画面"
                    src={`data:image/png;base64,${shot.image}`}
                  />
                </button>
              ) : !display ? (
                <p>正在同步大屏中的作品…</p>
              ) : null}
            </div>
          </div>
        </section>
        <aside className="live-discussion live-panel">
          <div className="live-heading">
            <h2>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />
              </svg>
              与丽塔同学对话
            </h2>
            <span title="选中单条消息中的文字，可引用或开启只读 Sidechat">
              {display ? '发言人' : '选中文字引用'}
            </span>
          </div>
          <div
            className="live-transcript"
            ref={transcript}
            onScroll={(event) => {
              const node = event.currentTarget;
              followTranscript.current =
                node.scrollHeight - node.clientHeight - node.scrollTop < 50;
            }}
          >
            {state?.history.length ? (
              state.history.map((turn) => (
                <article key={turn.id} className="conversation-turn">
                  <div className="chat-row user">
                    <span className="chat-avatar" aria-hidden="true">
                      发
                    </span>
                    <div className="chat-message">
                      <span className="bubble-speaker">发言人</span>
                      <div
                        className="live-bubble"
                        data-history-task={turn.id}
                        data-history-role="user"
                        data-history-message="prompt"
                      >
                        {turn.prompt}
                      </div>
                    </div>
                  </div>
                  {turn.messages.map((message) => (
                    <div className="chat-row" key={message.id}>
                      <span className="chat-avatar" aria-hidden="true">
                        灵
                      </span>
                      <div className="chat-message">
                        <span className="bubble-speaker">丽塔同学</span>
                        <div
                          className="live-bubble"
                          data-history-task={turn.id}
                          data-history-role="assistant"
                          data-history-message={message.id}
                        >
                          {message.text}
                        </div>
                      </div>
                    </div>
                  ))}
                  {turn.additions?.map((a) => (
                    <div className="chat-row user" key={a.id}>
                      <span className="chat-avatar" aria-hidden="true">
                        发
                      </span>
                      <div className="chat-message">
                        <span className="bubble-speaker">发言人</span>
                        <div className="live-bubble">
                          补充：{a.text}{' '}
                          {a.status === 'unconfirmed' || a.status === 'pending'
                            ? '（送达未确认，不会自动重复发送）'
                            : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                  <TurnUsage
                    usage={state.turnUsage.find((usage) => usage.taskId === turn.id)}
                    status={turn.status}
                  />
                  <div className="turn-footer">
                    {!display && (
                      <details className="turn-tools">
                        <summary aria-label="本轮详情" title="本轮详情">
                          ⋯
                        </summary>
                        {turn.attachments?.length ? (
                          <details>
                            <summary>本轮上下文 · {turn.attachments.length}</summary>
                            {turn.attachments.map((a) => (
                              <pre key={a.id}>
                                {a.title}\n{a.text}
                              </pre>
                            ))}
                          </details>
                        ) : null}
                        {!!turn.plan?.length && (
                          <details>
                            <summary>执行步骤 · {turn.plan.length}</summary>
                            <ol>
                              {turn.plan.map((step) => (
                                <li key={step.step}>
                                  {step.step} · {step.status}
                                </li>
                              ))}
                            </ol>
                          </details>
                        )}
                        {!!turn.items?.length && (
                          <details>
                            <summary>执行记录 · {turn.items.length}</summary>
                            {turn.items.map((item) => (
                              <details key={item.id}>
                                <summary>
                                  {item.type} · {item.status ?? '执行中'}
                                </summary>
                                <pre>{item.text}</pre>
                              </details>
                            ))}
                          </details>
                        )}
                        <small>
                          {turn.status} · {new Date(turn.createdAt).toLocaleString()}
                        </small>
                      </details>
                    )}
                    {!display && (
                      <div className="turn-icons">
                        {' '}
                        {!display && (
                          <div className="live-actions">
                            {turn.status === 'queued' ? (
                              <button
                                type="button"
                                onClick={() =>
                                  void operate('workspace', {
                                    action: 'cancel-queued',
                                    id: turn.id,
                                  })
                                }
                              >
                                取消排队
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  aria-label="Fork 对话"
                                  title="Fork 对话"
                                  disabled={running || !turn.turnId}
                                  onClick={() =>
                                    void operate('workspace', {
                                      action: 'fork',
                                      taskId: turn.id,
                                      kind: 'fork',
                                    })
                                  }
                                >
                                  <svg
                                    aria-hidden="true"
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.7"
                                  >
                                    <circle cx="6" cy="5" r="2" />
                                    <circle cx="18" cy="5" r="2" />
                                    <circle cx="6" cy="19" r="2" />
                                    <path d="M6 7v10M18 7v1a5 5 0 0 1-5 5H6" />
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  aria-label="复制本轮回复"
                                  title="复制本轮回复"
                                  disabled={!turn.messages.length}
                                  onClick={async () => {
                                    try {
                                      const value = turn.messages
                                        .map((message) => message.text)
                                        .join('\n\n');
                                      if (window.lingxiDesktop)
                                        await window.lingxiDesktop.copy(value);
                                      else await navigator.clipboard.writeText(value);
                                    } catch {
                                      setError('复制失败，请选中文字后复制。');
                                    }
                                  }}
                                >
                                  <svg
                                    aria-hidden="true"
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.7"
                                  >
                                    <rect x="8" y="8" width="12" height="12" rx="2" />
                                    <path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4" />
                                  </svg>
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              ))
            ) : (
              <div className="live-empty">
                <p>
                  {thread?.kind === 'sidechat'
                    ? '只读讨论：输入问题，完成后将结论添加回主对话。'
                    : '这一轮想做什么？'}
                </p>
              </div>
            )}
            {!display && thread?.kind === 'fork' && (
              <p>此 Fork 复制对话历史，共享当前项目文件。独立代码工作区尚未创建。</p>
            )}
          </div>
          <ContextUsage
            runtime={state?.runtime ?? null}
            turnId={task?.turnId}
            expanded={displayVoice?.contextDetailsOpen ?? false}
            onExpand={(open) => void contextDetails(open)}
          />
          <VoiceHandoff state={displayVoice} showSettings={!display} />
          {task && (
            <section
              className="live-agents"
              aria-label={task.threadId ? '本次实际调用的 Agent' : '执行进度'}
            >
              <p className="agent-group-title">{task.threadId ? '本次调用的 Agent' : '执行进度'}</p>
              <details className="live-activity" aria-label="实际执行进度" key={task.id}>
                <summary className="agent-identity">
                  <span className="agent-icon" aria-hidden="true">
                    <svg aria-hidden="true" viewBox="0 0 32 32" fill="none">
                      <path d="M5 5H21V21H5Z" fill="currentColor" fillOpacity=".08" />
                      <path d="M11 11H27V27H11Z" fill="currentColor" fillOpacity=".14" />
                      <g
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 8V5H5V21H21V14" />
                        <path d="M11 18V11H27V27H11V24" />
                      </g>
                      <path d="M15 15H21V21H15Z" fill="currentColor" fillOpacity=".22" />
                    </svg>
                  </span>
                  <strong>{task.threadId ? 'Codex' : '本轮任务'}</strong>
                  <span className={`agent-state task-state-${task.status}`}>
                    {task.status === 'waiting'
                      ? '等待确认'
                      : task.status === 'queued'
                        ? '排队中'
                        : task.status === 'starting'
                          ? '准备中'
                          : task.status === 'stopping'
                            ? '停止中'
                            : task.status === 'running'
                              ? '进行中'
                              : task.status === 'completed'
                                ? '✓ 已完成'
                                : task.status === 'failed'
                                  ? '失败'
                                  : '已停止'}
                  </span>
                </summary>
                <p className="runtime-stage">{task.activity}</p>
                {task.error && <p role="alert">{task.error}</p>}
              </details>
            </section>
          )}
          {!display &&
            task &&
            (task.approvals ?? (task.approval ? [task.approval] : [])).map((approval) => (
              <section className="live-approval" key={approval.id}>
                <h3>{approval.title}</h3>
                <pre>{approval.detail}</pre>
                {approval.questions?.map((question) => (
                  <label key={question.id} htmlFor={`question-${approval.id}-${question.id}`}>
                    {question.header && <strong>{question.header} · </strong>}
                    {question.question}
                    {question.options?.map((option) => (
                      <button
                        type="button"
                        key={option.label}
                        title={option.description}
                        onClick={() =>
                          setAnswers((old) => ({ ...old, [question.id]: option.label }))
                        }
                      >
                        {option.label}
                        <small>{option.description}</small>
                      </button>
                    ))}
                    {question.isSecret ? (
                      <input
                        type="password"
                        id={`question-${approval.id}-${question.id}`}
                        value={answers[question.id] ?? ''}
                        onChange={(e) =>
                          setAnswers((old) => ({ ...old, [question.id]: e.target.value }))
                        }
                        autoComplete="off"
                      />
                    ) : (
                      <textarea
                        id={`question-${approval.id}-${question.id}`}
                        value={answers[question.id] ?? ''}
                        onChange={(e) =>
                          setAnswers((old) => ({ ...old, [question.id]: e.target.value }))
                        }
                      />
                    )}
                    {!question.isSecret && voiceDraft && (
                      <button
                        type="button"
                        onClick={() =>
                          setAnswers((old) => ({ ...old, [question.id]: voiceDraft.text }))
                        }
                      >
                        使用语音转写
                      </button>
                    )}
                  </label>
                ))}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void operate('decision', {
                      taskId: task.id,
                      approvalId: approval.id,
                      decision: 'accept',
                      ...(approval.kind === 'question' ? { answers } : {}),
                    }).then((ok) => {
                      if (ok) setAnswers({});
                    });
                  }}
                >
                  {approval.kind === 'question' ? '提交回答' : '批准并继续'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void operate('decision', {
                      taskId: task.id,
                      approvalId: approval.id,
                      decision: 'decline',
                    })
                  }
                >
                  {approval.kind === 'question' ? '停止任务' : '拒绝'}
                </button>
              </section>
            ))}
          {!display && voiceDraft && (
            <div className="voice-draft">
              <p>语音转写：{voiceDraft.text}</p>
              <button
                type="button"
                disabled={state?.task?.id === voiceDraft.id}
                onClick={() => {
                  if (composer.current) composer.current.open = true;
                  setText((old) => {
                    const text = old ? `${old}\n${voiceDraft.text}` : voiceDraft.text;
                    retry.current = { text, id: voiceDraft.id };
                    return text;
                  });
                }}
              >
                使用转写草稿
              </button>
              <button type="button" onClick={() => setVoiceDraft(null)}>
                忽略转写
              </button>
            </div>
          )}
        </aside>
      </main>
      {!display && state && (
        <HistoryActions
          state={state}
          transcript={transcript}
          busy={busy}
          running={running}
          attachmentsFull={attachments.length >= 20}
          onSelect={() => {
            followTranscript.current = false;
          }}
          onQuote={quoteToDraft}
          onSidechat={(quote) => void discussQuote(quote)}
          {...(thread?.parentId
            ? { onReturn: (quote: HistoryQuote) => void returnQuote(quote) }
            : {})}
        />
      )}
      <footer className="live-footer">
        {display && (
          <div
            className={`live-mic-state ${displayVoice?.status === 'listening' ? 'listening' : ''}`}
          >
            <MicrophoneIcon
              muted={
                !displayVoice?.conversationActive &&
                displayVoice?.status !== 'listening' &&
                !['armed', 'detected'].includes(displayVoice?.wake.status ?? '')
              }
            />
            <strong>
              {!connected || !displayVoice
                ? '正在同步麦克风状态'
                : displayVoice.conversationActive
                  ? displayVoice.status === 'ready'
                    ? '语音会话开启 · 本机待说话 · 麦克风已开启'
                    : displayVoice.status === 'processing'
                      ? '正在处理这句话 · 语音会话保持开启'
                      : displayVoice.status === 'speaking'
                        ? '播报中 · 语音会话保持开启'
                        : '收音中 · 语音会话保持开启'
                  : ['armed', 'detected'].includes(displayVoice.wake.status) &&
                      displayVoice.status === 'ready'
                    ? `本地待唤醒 · 麦克风已开启 · ${displayVoice.wake.keyword}`
                    : displayVoice.status === 'speaking' &&
                        ['armed', 'detected'].includes(displayVoice.wake.status)
                      ? '播报中 · 本地麦克风开启，暂停唤醒'
                      : displayVoice.status === 'listening'
                        ? '收音中 · 麦克风已开启'
                        : '麦克风已关闭'}
            </strong>
            {displayVoice?.status === 'listening' && (
              <span>{displayVoice.draft || '正在听取本次指令…'}</span>
            )}
          </div>
        )}
        {!display && active && (
          <VoiceControls
            onDraft={receiveVoice}
            onState={setDisplayVoice}
            prepare={async () => {
              if (
                !state?.project ||
                !(await operate('context', {
                  projectId: state.project.id,
                  conversationId: state.selectedThreadId,
                  selection,
                  attachments,
                  text: composedText,
                }))
              )
                throw new Error('context_unavailable');
            }}
          />
        )}
        {!display && (
          <details className="keyboard-composer" ref={composer}>
            <summary>文字输入</summary>
            <form onSubmit={submit}>
              {state && (
                <ModelControls state={state} busy={busy} connected={connected} operate={operate} />
              )}
              {state && (
                <ExecutionControls
                  state={state}
                  busy={busy}
                  connected={connected}
                  operate={operate}
                />
              )}
              <label htmlFor="task-prompt">给 Codex 的本轮指令</label>
              <textarea
                id="task-prompt"
                maxLength={4000}
                rows={3}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="做一个周末出游投票页；或者：给金山城市沙滩投一票"
              />
              {!!attachments.length && (
                <div className="context-attachments">
                  {attachments.map((a) => (
                    <div key={a.id}>
                      <strong>{a.title}</strong>
                      <p>{a.text.slice(0, 150)}</p>
                      <button
                        type="button"
                        onClick={() => {
                          setAttachments((old) => old.filter((item) => item.id !== a.id));
                          retry.current = null;
                        }}
                      >
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {selection && (
                <div className="selection-tools">
                  <p>已选：{selection.description.slice(0, 80)}</p>
                  <label>
                    给选中元素的批注
                    <textarea
                      value={annotation}
                      maxLength={4000}
                      onChange={(event) => setAnnotation(event.target.value)}
                      placeholder="例如：背景改成粉色，保留文字"
                    />
                  </label>
                  <p>
                    可添加带批注的标记，也可在下方输入本轮指令直接提交；都会携带这个元素的上下文。
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      attach({
                        id: crypto.randomUUID(),
                        kind: 'browser',
                        title: selection.description.slice(0, 100),
                        text: `预览点选：${selection.description}${annotation.trim() ? `\n修改要求：${annotation.trim()}` : ''}`,
                        selection,
                      });
                      setSelection(null);
                      setAnnotation('');
                    }}
                  >
                    把此标记加入上下文
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelection(null);
                      setAnnotation('');
                      retry.current = null;
                    }}
                  >
                    清除选择
                  </button>
                </div>
              )}
              {running && (
                <label>
                  发送方式
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as 'queue' | 'steer')}
                  >
                    <option value="queue">排队到下一轮</option>
                    <option value="steer">立即补充当前任务</option>
                  </select>
                </label>
              )}
              {staleSelection && (
                <p className="error" role="alert">
                  作品已更新，请移除过期标记并重新点选。输入已保留。
                </p>
              )}
              <div className="live-actions">
                <button
                  className="send-task"
                  type="submit"
                  disabled={
                    busy ||
                    staleSelection ||
                    !state?.project ||
                    (!text.trim() && !(selection && annotation.trim())) ||
                    !connected
                  }
                >
                  {running ? (mode === 'queue' ? '排队发送' : '补充当前任务') : '提交给 Codex'}
                </button>
                {running && (
                  <button
                    type="button"
                    disabled={busy || task?.status === 'stopping'}
                    onClick={() => void operate('interrupt', {})}
                  >
                    停止任务
                  </button>
                )}
              </div>
            </form>
          </details>
        )}
        {!display && error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </footer>
    </div>
  );
}
