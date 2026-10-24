import {
  type ContextAttachment,
  type PreviewSelection,
  type PreviewSnapshot,
  previewSnapshotSchema,
  type WorkbenchState,
  workbenchSchema,
} from '@lingxi/protocol';
import { type FormEvent, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ContextUsage } from './ContextUsage';
import { DiffPanel } from './DiffPanel';
import { ExecutionControls } from './ExecutionControls';
import { ModelControls } from './ModelControls';
import { TurnUsage } from './TurnUsage';
import { VoiceControls } from './VoiceControls';
import { WorkspaceTools } from './WorkspaceTools';

const TerminalPanel = lazy(() =>
  import('./TerminalPanel').then((module) => ({ default: module.TerminalPanel })),
);

export function DesktopWorkbench() {
  const display = location.pathname === '/display';
  const [state, setState] = useState<WorkbenchState | null>(null),
    [connected, setConnected] = useState(false),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [shot, setShot] = useState<PreviewSnapshot | null>(null),
    [answers, setAnswers] = useState<Record<string, string>>({});
  const transcript = useRef<HTMLDivElement>(null),
    followTranscript = useRef(true);
  const viewport = useRef<HTMLDivElement>(null),
    retry = useRef<{ text: string; id: string } | null>(null);
  const [picking, setPicking] = useState(false),
    [selection, setSelection] = useState<PreviewSelection | null>(null);
  const [runtimeUrl, setRuntimeUrl] = useState('http://127.0.0.1:5174/');
  const [tab, setTab] = useState('preview'),
    [attachments, setAttachments] = useState<ContextAttachment[]>([]);
  const [mode, setMode] = useState<'queue' | 'steer'>('queue'),
    [search, setSearch] = useState(''),
    [rename, setRename] = useState('');
  const [voiceDraft, setVoiceDraft] = useState<{ text: string; id: string } | null>(null);
  const receiveVoice = useCallback((text: string, id: string) => setVoiceDraft({ text, id }), []);
  const bindingKey = state?.preview ? JSON.stringify(state.preview) : '';
  const thread = state?.threads.find((t) => t.id === state.selectedThreadId);
  function attach(value: ContextAttachment) {
    setAttachments((old) => (old.length < 20 ? [...old, value] : old));
    retry.current = null;
  }
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
  async function operate(operation: string, body: unknown) {
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
      return true;
    } catch {
      setError('操作未完成，输入已保留。请检查连接、当前任务和连接向导后重试。');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const draft = text.trim();
    if (!draft) return;
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
      setText('');
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
          <span className="brand-mark">灵</span>
          <span>
            灵矽<small>{state?.project?.name ?? '共创工作台'}</small>
          </span>
        </a>
        <div className="live-actions">
          <span role="status">{connected ? '本机服务已连接' : '正在重连本机服务'}</span>
          {!display && (
            <>
              <button
                type="button"
                onClick={() => void operate('action', { action: 'open-display' })}
              >
                打开大屏
              </button>
              <a href="/setup">连接向导</a>
            </>
          )}
        </div>
      </header>
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
          <span>{state?.project?.path ?? '先选择一个允许 Codex 修改的文件夹'}</span>
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
                  {t.kind === 'sidechat' ? 'Sidechat · ' : t.kind === 'fork' ? 'Fork · ' : ''}
                  {t.title}
                </option>
              ))}
          </select>
          <button
            type="button"
            disabled={running || busy}
            onClick={() => void operate('workspace', { action: 'new-thread', title: '新对话' })}
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
                  onClick={() => void operate('workspace', { action: 'select-thread', id: t.id })}
                >
                  {t.title}
                </button>
              ))}
          </details>
        </section>
      )}
      <main className="live-grid">
        <section className="live-preview live-panel">
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
                  onClick={() => setTab(value ?? 'preview')}
                >
                  {label}
                </button>
              ))}
            </nav>
          )}
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
          {!display && tab === 'preview' && (
            <details>
              <summary>连接项目开发服务器</summary>
              <p>
                先在终端启动项目（如 npm run dev -- --port 5174），再连接其本机地址。大屏和 Codex
                会使用同一页面。
              </p>
              <input
                aria-label="项目预览地址"
                value={runtimeUrl}
                onChange={(e) => setRuntimeUrl(e.target.value)}
              />
              <button
                type="button"
                onClick={() => void operate('preview-url', { url: runtimeUrl })}
              >
                连接预览
              </button>
            </details>
          )}
          <div
            className="preview-surface"
            style={{ display: display || tab === 'preview' ? 'flex' : 'none' }}
          >
            <div className="live-heading">
              <h1>项目预览</h1>
              <span>{state?.preview ? `版本 ${state.preview.revision}` : '等待作品'}</span>
            </div>
            <div ref={viewport} className="live-viewport" data-testid="canonical-viewport">
              {!state?.preview ? (
                <div className="live-empty">
                  <span>✧</span>
                  <h2>聊聊你的想法吧。</h2>
                  <p>
                    {state?.project
                      ? '写下需求，交给 Codex 完成这一轮开发。'
                      : '打开或新建项目，再从一个具体的想法开始。'}
                  </p>
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
            {!display && state?.preview && (
              <p className="preview-caption">
                <button
                  type="button"
                  onClick={() => {
                    setPicking((value) => !value);
                    retry.current = null;
                  }}
                >
                  {picking ? '取消点选' : '点选修改'}
                </button>{' '}
                {selection
                  ? `已选：${selection.description.slice(0, 80)}`
                  : '选中元素后，在右侧输入修改要求。体验作品可直接操作大屏窗口。'}
                {selection && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelection(null);
                      retry.current = null;
                    }}
                  >
                    清除选择
                  </button>
                )}
              </p>
            )}
          </div>
        </section>
        <aside className="live-discussion live-panel">
          <div className="live-heading">
            <h2>与灵矽对话</h2>
            <span>Codex</span>
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
                  <div className="live-bubble user">{turn.prompt}</div>
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
                  {turn.messages.map((message) => (
                    <div className="live-bubble" key={message.id}>
                      {message.text}
                    </div>
                  ))}
                  {turn.additions?.map((a) => (
                    <div className="live-bubble user" key={a.id}>
                      补充：{a.text}{' '}
                      {a.status === 'unconfirmed' || a.status === 'pending'
                        ? '（送达未确认，不会自动重复发送）'
                        : ''}
                    </div>
                  ))}
                  {!!turn.plan?.length && (
                    <ol>
                      {turn.plan.map((step) => (
                        <li key={step.step}>
                          {step.step} · {step.status}
                        </li>
                      ))}
                    </ol>
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
                          <button
                            type="button"
                            onClick={() =>
                              attach({
                                id: crypto.randomUUID(),
                                kind: 'text',
                                title: item.type,
                                text: item.text.slice(0, 32000),
                              })
                            }
                          >
                            添加到对话
                          </button>
                        </details>
                      ))}
                    </details>
                  )}
                  <small>
                    {turn.status} · {new Date(turn.createdAt).toLocaleString()}
                  </small>
                  <TurnUsage
                    usage={state.turnUsage.find((usage) => usage.taskId === turn.id)}
                    status={turn.status}
                    compact={display}
                  />
                  {!display && (
                    <div className="live-actions">
                      <button
                        type="button"
                        onClick={() =>
                          attach({
                            id: crypto.randomUUID(),
                            kind: thread?.kind === 'sidechat' ? 'sidechat' : 'text',
                            title: '对话摘录',
                            text: turn.messages
                              .map((m) => m.text)
                              .join('\n')
                              .slice(0, 32000),
                          })
                        }
                      >
                        添加到对话
                      </button>
                      {turn.status === 'queued' ? (
                        <button
                          type="button"
                          onClick={() =>
                            void operate('workspace', { action: 'cancel-queued', id: turn.id })
                          }
                        >
                          取消排队
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={running || !turn.turnId}
                            onClick={() =>
                              void operate('workspace', {
                                action: 'fork',
                                taskId: turn.id,
                                kind: 'sidechat',
                              })
                            }
                          >
                            Sidechat
                          </button>
                          <button
                            type="button"
                            disabled={running || !turn.turnId}
                            onClick={() =>
                              void operate('workspace', {
                                action: 'fork',
                                taskId: turn.id,
                                kind: 'fork',
                              })
                            }
                          >
                            Fork 对话
                          </button>
                        </>
                      )}
                    </div>
                  )}
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
            {!display && thread?.parentId && (
              <button
                type="button"
                disabled={running}
                onClick={() => {
                  const text =
                    state?.history.flatMap((t) => t.messages.map((m) => m.text)).join('\n') ?? '';
                  attach({
                    id: crypto.randomUUID(),
                    kind: 'sidechat',
                    title: thread.title,
                    text: text.slice(0, 32000),
                  });
                  void operate('workspace', { action: 'select-thread', id: thread.parentId });
                }}
              >
                把讨论结果带回原对话
              </button>
            )}
            {!display && thread?.kind === 'fork' && (
              <p>此 Fork 复制对话历史，共享当前项目文件。独立代码工作区尚未创建。</p>
            )}
          </div>
          {task && (
            <section className="live-activity" aria-label="实际执行进度">
              <h3>本轮执行</h3>
              <p>
                <span className={`activity-dot ${running ? 'active' : ''}`} /> Codex ·{' '}
                {task.activity}
              </p>
              {task.error && <p role="alert">{task.error}</p>}
            </section>
          )}
          <ContextUsage runtime={state?.runtime ?? null} turnId={task?.turnId} compact={display} />
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
          {!display && (
            <>
              <VoiceControls
                onDraft={receiveVoice}
                prepare={async () => {
                  if (
                    !state?.project ||
                    !(await operate('context', {
                      projectId: state.project.id,
                      conversationId: state.selectedThreadId,
                      selection,
                      attachments,
                      text,
                    }))
                  )
                    throw new Error('context_unavailable');
                }}
              />
              {voiceDraft && (
                <div className="voice-draft">
                  <p>语音转写：{voiceDraft.text}</p>
                  <button
                    type="button"
                    disabled={state?.task?.id === voiceDraft.id}
                    onClick={() => {
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
            </>
          )}
          {!display && (
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
                <button
                  type="button"
                  onClick={() => {
                    attach({
                      id: crypto.randomUUID(),
                      kind: 'browser',
                      title: selection.description.slice(0, 100),
                      text: `预览点选：${selection.description}`,
                      selection,
                    });
                    setSelection(null);
                  }}
                >
                  把此标记加入上下文
                </button>
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
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="live-actions">
                <button
                  className="send-task"
                  type="submit"
                  disabled={busy || staleSelection || !state?.project || !text.trim() || !connected}
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
          )}
        </aside>
      </main>
      <footer className="live-footer">
        <span>
          {task?.status === 'waiting'
            ? '等待操作台确认'
            : running
              ? task.activity
              : '准备好后，提交下一轮指令'}
        </span>
        <span>
          {thread?.kind === 'sidechat' ? '只读 Sidechat' : '本机项目 · AirPlay 请在 macOS 连接'}
        </span>
      </footer>
    </div>
  );
}
