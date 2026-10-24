import {
  type PreviewSelection,
  type PreviewSnapshot,
  previewSnapshotSchema,
  type TaskDecision,
  type WorkbenchState,
  workbenchSchema,
} from '@lingxi/protocol';
import { type FormEvent, useEffect, useRef, useState } from 'react';

export function DesktopWorkbench() {
  const display = location.pathname === '/display';
  const [state, setState] = useState<WorkbenchState | null>(null),
    [connected, setConnected] = useState(false),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [shot, setShot] = useState<PreviewSnapshot | null>(null),
    [answers, setAnswers] = useState<Record<string, string>>({});
  const viewport = useRef<HTMLDivElement>(null),
    retry = useRef<{ text: string; id: string } | null>(null);
  const [picking, setPicking] = useState(false),
    [selection, setSelection] = useState<PreviewSelection | null>(null);
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
    if (!display || !element || !state?.preview) return;
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
  }, [display, state?.preview]);
  useEffect(() => {
    if (display || !state?.preview) {
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
  }, [display, state?.preview]);
  const staleSelection =
    !!selection && JSON.stringify(selection.binding) !== JSON.stringify(state?.preview);
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
      setState(workbenchSchema.parse(await response.json()));
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
      })
    ) {
      setText('');
      setSelection(null);
      retry.current = null;
    }
  }
  async function decide(decision: TaskDecision['decision']) {
    if (task?.approval)
      await operate('decision', {
        taskId: task.id,
        approvalId: task.approval.id,
        decision,
        ...(task.approval.kind === 'question' ? { answers } : {}),
      });
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
      <main className="live-grid">
        <section className="live-preview live-panel">
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
                disabled={!picking || running}
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
        </section>
        <aside className="live-discussion live-panel">
          <div className="live-heading">
            <h2>与灵矽对话</h2>
            <span>Codex</span>
          </div>
          <div className="live-transcript">
            {task ? (
              <>
                <div className="live-bubble user">{task.prompt}</div>
                {task.messages.map((message) => (
                  <div className="live-bubble" key={message.id}>
                    {message.text}
                  </div>
                ))}
              </>
            ) : (
              <div className="live-empty">
                <p>
                  这一轮想做什么？
                  <br />
                  也可以要求 Codex 操作已经展示的作品。
                </p>
              </div>
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
          {task?.approval && !display && (
            <section className="live-approval">
              <h3>{task.approval.title}</h3>
              <pre>{task.approval.detail}</pre>
              {task.approval.questions?.map((question) => (
                <label key={question.id}>
                  {question.question}
                  <textarea
                    value={answers[question.id] ?? ''}
                    onChange={(event) =>
                      setAnswers((previous) => ({ ...previous, [question.id]: event.target.value }))
                    }
                  />
                </label>
              ))}
              <button type="button" disabled={busy} onClick={() => void decide('accept')}>
                批准并继续
              </button>
              <button type="button" disabled={busy} onClick={() => void decide('decline')}>
                {task.approval.kind === 'question' ? '停止任务' : '拒绝'}
              </button>
            </section>
          )}
          {!display && (
            <form onSubmit={submit}>
              <label htmlFor="task-prompt">给 Codex 的本轮指令</label>
              <textarea
                id="task-prompt"
                maxLength={4000}
                rows={3}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="做一个周末出游投票页；或者：给金山城市沙滩投一票"
              />
              {staleSelection && (
                <p className="error" role="alert">
                  作品已更新，请清除选择并重新点选。输入已保留。
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
                  disabled={
                    busy ||
                    running ||
                    staleSelection ||
                    !state?.project ||
                    !text.trim() ||
                    !connected
                  }
                >
                  提交给 Codex
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
        <span>灵矽语音待接入 · 麦克风未启用</span>
      </footer>
    </div>
  );
}
