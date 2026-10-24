import { type SetupInspection, setupInspectionSchema, setupIssues } from '@lingxi/protocol';
import { useEffect, useState } from 'react';
import { App } from './App';
import { SetupPage } from './SetupPage';

export function RuntimeApp() {
  const [phase, setPhase] = useState<'checking' | 'setup' | 'ready'>(() =>
    location.pathname === '/setup'
      ? 'setup'
      : window.lingxiDesktop && location.pathname !== '/display'
        ? 'checking'
        : 'ready',
  );
  const [inspection, setInspection] = useState<SetupInspection | null>(null);
  useEffect(() => {
    if (phase !== 'checking') return;
    const controller = new AbortController();
    const check = async () => {
      let result: SetupInspection | null = null;
      try {
        const response = await fetch('/api/setup/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
        });
        if (!response.ok) throw new Error('inspection_unavailable');
        result = setupInspectionSchema.parse(await response.json());
      } catch {
        /* Failed diagnostics belong in the wizard, not a redirect loop. */
      }
      if (controller.signal.aborted) return;
      setInspection(result);
      if (!result || setupIssues(result).length) {
        history.replaceState(null, '', '/setup');
        setPhase('setup');
      } else setPhase('ready');
    };
    void check();
    return () => controller.abort();
  }, [phase]);
  if (phase === 'checking')
    return (
      <main className="workbench setup">
        <section className="panel setup-result" role="status">
          <h1>正在检查运行配置…</h1>
          <p>检查 Codex、灵矽、唤醒模型与麦克风权限；不会自动下载、登录、连接语音或打开麦克风。</p>
        </section>
      </main>
    );
  if (phase === 'setup')
    return (
      <SetupPage
        initialInspection={inspection}
        onContinue={() => {
          history.replaceState(null, '', '/');
          setInspection(null);
          setPhase('ready');
        }}
      />
    );
  return <App />;
}
