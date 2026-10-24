import { type SetupInspection, setupInspectionSchema, setupIssues } from '@lingxi/protocol';
import { useEffect, useState } from 'react';
import { App } from './App';
import { Navigation, type SettingsSection } from './Navigation';
import { SettingsPage } from './SettingsPage';
import { SetupPage } from './SetupPage';

export function RuntimeApp() {
  const [phase, setPhase] = useState<'checking' | 'setup' | 'settings' | 'ready'>(() =>
    location.pathname === '/settings'
      ? 'settings'
      : location.pathname === '/setup'
        ? 'setup'
        : window.lingxiDesktop && location.pathname !== '/display'
          ? 'checking'
          : 'ready',
  );
  const [hasWorkspace, setHasWorkspace] = useState(phase === 'ready');
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
      } else {
        setHasWorkspace(true);
        setPhase('ready');
      }
    };
    void check();
    return () => controller.abort();
  }, [phase]);
  const openSettings = (section?: SettingsSection) => {
    history.pushState(null, '', `/settings${section ? `#${section}` : ''}`);
    setPhase('settings');
  };
  const openSetup = () => {
    history.pushState(null, '', '/setup');
    setInspection(null);
    setPhase('setup');
  };
  const closeConfiguration = () => {
    history.replaceState(null, '', '/');
    setInspection(null);
    setHasWorkspace(true);
    setPhase('ready');
  };
  useEffect(() => {
    const back = () => {
      setInspection(null);
      setPhase(
        location.pathname === '/settings'
          ? 'settings'
          : location.pathname === '/setup'
            ? 'setup'
            : hasWorkspace
              ? 'ready'
              : 'checking',
      );
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, [hasWorkspace]);
  return (
    <Navigation.Provider value={{ settings: openSettings, setup: openSetup }}>
      {hasWorkspace && (
        <div hidden={phase !== 'ready'}>
          <App active={phase === 'ready'} />
        </div>
      )}
      {phase === 'checking' && (
        <main className="workbench setup">
          <section className="panel setup-result" role="status">
            <h1>正在检查运行配置…</h1>
            <p>
              检查 Codex、灵矽、唤醒模型与麦克风权限；不会自动下载、登录、连接语音或打开麦克风。
            </p>
          </section>
        </main>
      )}
      {phase === 'setup' && (
        <SetupPage initialInspection={inspection} onContinue={closeConfiguration} />
      )}
      {phase === 'settings' && <SettingsPage onClose={closeConfiguration} />}
    </Navigation.Provider>
  );
}
