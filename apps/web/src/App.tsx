import { errorSchema, type Session, sessionSchema } from '@lingxi/protocol';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

const sourceLabels = { keyboard: '键盘', voice: '语音', pointer: '点选' } as const;

export function App() {
  const display = window.location.pathname === '/display';
  const [session, setSession] = useState<Session | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>(
    'connecting',
  );
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ text: string; id: string } | null>(null);

  const acceptSnapshot = useCallback((snapshot: Session) => {
    setSession((previous) =>
      !previous || snapshot.revision >= previous.revision ? snapshot : previous,
    );
  }, []);

  useEffect(() => {
    let events: EventSource | null = null;
    const onSnapshot = (event: MessageEvent<string>) => {
      try {
        const parsed = sessionSchema.safeParse(JSON.parse(event.data));
        if (parsed.success) acceptSnapshot(parsed.data);
      } catch {
        /* Keep the last valid picture while reconnecting. */
      }
    };
    const disconnect = () => {
      events?.close();
      events = null;
      setConnection('disconnected');
    };
    const connect = () => {
      events?.close();
      if (!navigator.onLine) {
        disconnect();
        return;
      }
      setConnection('connecting');
      events = new EventSource('/api/events');
      events.onopen = () => setConnection('connected');
      events.onerror = () => setConnection('disconnected');
      events.addEventListener('session.snapshot', onSnapshot);
    };
    window.addEventListener('offline', disconnect);
    window.addEventListener('online', connect);
    connect();
    return () => {
      window.removeEventListener('offline', disconnect);
      window.removeEventListener('online', connect);
      events?.close();
    };
  }, [acceptSnapshot]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session || !text.trim() || busy) return;
    setBusy(true);
    setError('');
    const draft = text.trim();
    if (pending.current?.text !== draft) pending.current = { text: draft, id: crypto.randomUUID() };
    try {
      const response = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId: pending.current.id,
          source: 'keyboard',
          text: draft,
          expectedRevision: session.revision,
        }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const parsed = errorSchema.safeParse(data);
        if (parsed.success && parsed.data.error === 'revision_conflict') {
          const latest = await fetch('/api/session');
          if (latest.ok) acceptSnapshot(sessionSchema.parse(await latest.json()));
          setError('已有新的修改建议，请核对画面后再次提交。你的输入已保留。');
          return;
        }
        throw new Error('submission failed');
      }
      acceptSnapshot(sessionSchema.parse(data));
      pending.current = null;
      setText('');
    } catch {
      setError('暂时无法保存，输入已保留。连接恢复后可以重试。');
    } finally {
      setBusy(false);
    }
  }

  const commands = session?.commands ?? [];
  const visibleCommands = display ? commands.slice(-5) : commands;
  const status =
    connection === 'connected'
      ? '实时同步'
      : connection === 'connecting'
        ? '正在连接'
        : '连接中断 · 正在重连';

  return (
    <div className={`workbench ${display ? 'display' : ''}`}>
      <header className="topbar">
        <a className="brand" href={display ? '/display' : '/'}>
          <span className="brand-mark">灵</span>
          <span>
            灵矽 <span className="brand-detail">/ 共创工作台</span>
          </span>
        </a>
        <div className="topbar-actions">
          <span className={`connection ${connection}`} role="status">
            {status}
          </span>
          {!display && (
            <a className="setup-link" href="/setup">
              连接向导
            </a>
          )}
          {!display && (
            <a className="button secondary" href="/display" target="_blank" rel="noreferrer">
              打开大屏 ↗
            </a>
          )}
        </div>
      </header>
      <section className="intro">
        <p className="eyebrow">一起讨论，一起做出来</p>
        <h1>让想法在眼前发生。</h1>
        <p className="intro-detail">
          {display
            ? '大家看到同一份进展，修改建议会从电脑端同步到这里。'
            : '先把这一轮想做的事写下来，再和大家一起看着它成形。'}
        </p>
        {!display && (
          <p className="setup-intro">
            第一次使用？<a href="/setup">从 Mac 连接向导开始 →</a>
          </p>
        )}
      </section>
      <main className="workspace">
        <section className="preview panel" aria-labelledby="preview-title">
          <div className="panel-heading">
            <h2 id="preview-title">项目预览</h2>
            <span className="muted">等待第一个作品</span>
          </div>
          <div className="empty-preview">
            <div className="preview-symbol" aria-hidden="true">
              ＋
            </div>
            <h3>从一个具体的想法开始</h3>
            <p>
              连接 Codex 后，这里会展示运行中的作品。
              <br />
              现在可以先整理和保存修改建议。
            </p>
          </div>
          <div className="integration-bar">
            <span>
              <i className="integration-dot" /> Codex 待连接
            </span>
            <span>
              <i className="integration-dot" /> 灵矽语音待连接
            </span>
          </div>
        </section>
        <aside className="discussion panel" aria-labelledby="discussion-title">
          <div className="panel-heading">
            <h2 id="discussion-title">这轮修改建议</h2>
            <span className="muted">{commands.length} 条</span>
          </div>
          <p className="discussion-note">建议会保存在本机，目前尚未执行。</p>
          {commands.length === 0 ? (
            <div className="empty-discussion">
              把“这里可以更好”
              <br />
              变成一句具体的修改。
            </div>
          ) : (
            <ol className="commands" aria-label="已保存的修改建议">
              {visibleCommands.map((command, index) => (
                <li key={command.id}>
                  <div className="command-meta">
                    <span>
                      {String(commands.length - visibleCommands.length + index + 1).padStart(
                        2,
                        '0',
                      )}{' '}
                      · {sourceLabels[command.source]}
                    </span>
                    <span>待执行</span>
                  </div>
                  <p>{command.text}</p>
                </li>
              ))}
            </ol>
          )}
          {!display && (
            <form onSubmit={submit}>
              <label htmlFor="command-text">添加修改建议</label>
              <textarea
                id="command-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="例如：把首页标题改成“周末，一起去哪里？”"
                rows={4}
                maxLength={4000}
                disabled={busy}
              />
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button
                className="button primary"
                type="submit"
                disabled={!session || !text.trim() || busy || connection !== 'connected'}
              >
                {busy ? '正在保存…' : '保存修改建议'}
              </button>
            </form>
          )}
        </aside>
      </main>
      <footer>
        <span>
          {display
            ? '需要补充细节时，可以回到电脑端输入。'
            : '语音、点选和键盘输入会在后续接入同一个会话。'}
        </span>
        <span>本地会话 · 版本 {session?.revision ?? '—'}</span>
      </footer>
    </div>
  );
}
