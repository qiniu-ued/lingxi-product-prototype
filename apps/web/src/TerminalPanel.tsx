import type { ContextAttachment, WorkbenchState } from '@lingxi/protocol';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { ConfigurationButton } from './ConfigurationControls.js';
import '@xterm/xterm/css/xterm.css';

async function send(body: unknown) {
  const response = await fetch('/api/workbench/terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('terminal unavailable');
}
export function TerminalPanel({
  state,
  attach,
}: {
  state: WorkbenchState;
  attach: (value: ContextAttachment) => void;
}) {
  const node = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | null>(null);
  const seq = useRef(0),
    id = state.terminal?.id;
  const [error, setError] = useState('');
  const openId = useRef(crypto.randomUUID());
  const active = state.terminal && ['starting', 'running'].includes(state.terminal.status);
  useEffect(() => {
    if (!node.current || !id) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      scrollback: 3000,
      theme: { background: '#191b20', foreground: '#e8e2d8' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node.current);
    terminal.current = term;
    seq.current = 0;
    const resize = () => {
      fit.fit();
      void send({ action: 'resize', id, cols: term.cols, rows: term.rows }).catch(() => {});
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node.current);
    resize();
    const data = term.onData((data) => {
      void send({ action: 'write', id, data }).catch(() =>
        setError('输入未送达。请检查终端状态，勿盲目重复执行。'),
      );
    });
    return () => {
      observer.disconnect();
      data.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, [id]);
  useEffect(() => {
    if (!terminal.current) return;
    for (const chunk of state.terminal?.chunks ?? []) {
      if (chunk.seq > seq.current) {
        terminal.current.write(Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0)));
        seq.current = chunk.seq;
      }
    }
  }, [state.terminal]);
  return (
    <section className="workspace-tool">
      <div className="live-actions">
        <ConfigurationButton
          type="button"
          disabled={!!active}
          onClick={() => {
            void send({ action: 'open', requestId: openId.current })
              .then(() => {
                openId.current = crypto.randomUUID();
                setError('');
              })
              .catch(() => setError('无法打开终端。请检查 CLI 版本；Sidechat 不提供终端。'));
          }}
        >
          打开终端
        </ConfigurationButton>
        <ConfigurationButton
          type="button"
          disabled={!active}
          onClick={() => {
            if (id)
              void send({ action: 'stop', id }).catch(() => setError('停止未确认，请检查连接。'));
          }}
        >
          结束终端
        </ConfigurationButton>
        <ConfigurationButton
          type="button"
          onClick={() => {
            const text = terminal.current?.getSelection();
            if (text)
              attach({
                id: crypto.randomUUID(),
                kind: 'terminal',
                title: '终端选中输出',
                text: text.slice(0, 32000),
              });
            else setError('先在终端中选中要加入对话的输出。');
          }}
        >
          添加选中输出到对话
        </ConfigurationButton>
      </div>
      <p>
        项目终端 · {state.terminal?.status ?? '未打开'} · 停止 Codex
        任务不会结束此终端。退出应用会结束它。
      </p>
      <div ref={node} className="terminal-viewport" />
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
