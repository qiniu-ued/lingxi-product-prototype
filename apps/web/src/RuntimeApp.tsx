import { type SetupInspection, setupInspectionSchema, setupIssues } from '@lingxi/protocol';
import { useEffect, useState } from 'react';
import { App } from './App';
import { Navigation, type SettingsSection } from './Navigation';
import { SettingsPage } from './SettingsPage';

export function RuntimeApp() {
  const [phase, setPhase] = useState<'checking' | 'settings' | 'ready'>(() =>
    location.pathname === '/settings' || location.pathname === '/setup'
      ? 'settings'
      : window.lingxiDesktop && location.pathname !== '/display'
        ? 'checking'
        : 'ready',
  );
  const [selectMissing, setSelectMissing] = useState(true);
  const [hasWorkspace, setHasWorkspace] = useState(phase === 'ready');
  const [inspection, setInspection] = useState<SetupInspection | null>(null);
  useEffect(() => {
    if (location.pathname === '/settings') history.replaceState(null, '', `/setup${location.hash}`);
  }, []);
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
        /* Failed diagnostics belong in settings, not a redirect loop. */
      }
      if (controller.signal.aborted) return;
      setInspection(result);
      if (!result || setupIssues(result).length) {
        history.replaceState(null, '', '/setup');
        setSelectMissing(true);
        setPhase('settings');
      } else {
        setHasWorkspace(true);
        setPhase('ready');
      }
    };
    void check();
    return () => controller.abort();
  }, [phase]);
  const openSettings = (section?: SettingsSection) => {
    history.pushState(null, '', `/setup${section ? `#${section}` : ''}`);
    setInspection(null);
    setSelectMissing(!section);
    setPhase('settings');
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
      const legacy = location.pathname === '/settings';
      setSelectMissing(true);
      if (legacy) history.replaceState(null, '', `/setup${location.hash}`);
      setPhase(location.pathname === '/setup' ? 'settings' : hasWorkspace ? 'ready' : 'checking');
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, [hasWorkspace]);
  return (
    <Navigation.Provider value={{ settings: openSettings }}>
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
              检查 Codex、丽塔同学、唤醒模型与麦克风权限；不会自动下载、登录、连接语音或打开麦克风。
            </p>
          </section>
        </main>
      )}
      {phase === 'settings' && (
        <SettingsPage
          initialInspection={inspection}
          selectMissing={selectMissing}
          onClose={closeConfiguration}
        />
      )}
    </Navigation.Provider>
  );
}
