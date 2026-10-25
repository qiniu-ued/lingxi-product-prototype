import {
  CODEX_SETUP_PACKAGE,
  type CodexCheck,
  type CodexSetupAction,
  type CodexSetupRequest,
  codexCheckSchema,
  codexSetupStateSchema,
  type SetupInspection,
  type SetupStatus,
  setupInspectionSchema,
  type VoiceState,
} from '@lingxi/protocol';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfigurationButton } from './ConfigurationControls';
import { SparklesIcon } from './DesktopWorkbench';
import { VoiceControls } from './VoiceControls';

const sections = ['codex', 'lingxi', 'wake'];
const titles = ['Codex', '丽塔同学与语音执行', '语音唤醒与麦克风'];
const finished = (action: CodexSetupAction) =>
  ['succeeded', 'failed', 'cancelled'].includes(action.state);
const codexMessages: Record<CodexCheck['status'], { title: string; detail: string }> = {
  ready: {
    title: 'Codex 环境检查通过',
    detail: 'CLI、App Server 与认证配置可用，可回到工作台执行任务。',
  },
  'not-installed': {
    title: '未找到 Codex CLI',
    detail: '可在此安装最新版。只有 Codex 桌面应用时，也需要 CLI 来提供本地接口。',
  },
  'signed-out': {
    title: 'Codex 尚未登录',
    detail: 'CLI 与 App Server 可用。下一步是在官方网页完成账号授权。',
  },
  failed: {
    title: '未能完成 Codex 检查',
    detail: '请重新检测；仍失败时，展开下方终端操作说明检查 CLI 与配置。',
  },
  'timed-out': { title: 'Codex 检查超时', detail: '请确认 CLI 可以正常启动，检查网络后重试。' },
};
const actionLabels: Record<CodexSetupAction['state'], string> = {
  installing: '正在下载并安装最新版 Codex…',
  'starting-login': '正在准备官方登录…',
  'waiting-for-login': '等待你在官方网页完成授权…',
  checking: '正在重新检查 Codex…',
  cancelling: '正在停止并清理进程…',
  succeeded: '操作完成',
  failed: '操作未完成',
  cancelled: '已停止本次操作',
};
const errors: Record<NonNullable<CodexSetupAction['error']>, string> = {
  install_failed: '安装失败，请检查网络与 npm 是否可用，然后重试或使用终端安装。',
  verification_failed: '安装或授权后未通过环境检查。请重新检测，查看终端操作说明。',
  login_failed: '未完成官方授权，请重试或在终端运行 codex login。',
  timed_out: '操作超时，已停止等待。可以重试。',
  custom_path_configured:
    '服务已指定自定义 CLI 路径，请在终端更新该安装，或移除路径设置后重启服务。',
};

function Command({ children }: { children: string }) {
  const [notice, setNotice] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(children);
      setNotice('已复制');
    } catch {
      setNotice('请选中下方命令并复制');
    }
  }
  return (
    <div className="setup-command">
      <div className="command-toolbar">
        <span>在 Mac 终端执行</span>
        <ConfigurationButton type="button" onClick={copy}>
          复制命令
        </ConfigurationButton>
      </div>
      <pre>
        <code>{children}</code>
      </pre>
      {notice && (
        <span className="copy-notice" role="status">
          {notice}
        </span>
      )}
    </div>
  );
}
function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="setup-link" href={href} target="_blank" rel="noreferrer">
      {children} ↗
    </a>
  );
}
async function readCheck(signal?: AbortSignal) {
  const response = await fetch('/api/setup/codex/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: signal ?? AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error('check unavailable');
  return codexCheckSchema.parse(await response.json());
}

export function SetupPage({
  initialInspection = null,
  onContinue,
  selectMissing = false,
}: {
  initialInspection?: SetupInspection | null;
  onContinue: () => void;
  selectMissing?: boolean;
}) {
  const seeded = useRef(initialInspection);
  const [wake, setWake] = useState<SetupInspection['wake']>(null);
  const [microphone, setMicrophone] = useState<SetupInspection['microphone']>('unknown');
  const modelObserved = useRef(false);
  const [step, setStep] = useState(() => Math.max(0, sections.indexOf(location.hash.slice(1))));
  useEffect(() => {
    const selectSection = () => setStep(Math.max(0, sections.indexOf(location.hash.slice(1))));
    window.addEventListener('hashchange', selectSection);
    window.addEventListener('popstate', selectSection);
    return () => {
      window.removeEventListener('hashchange', selectSection);
      window.removeEventListener('popstate', selectSection);
    };
  }, []);
  const [desktopInfo, setDesktopInfo] = useState<{
    platform: string;
    arch: string;
    systemVersion: string;
  } | null>(null);
  useEffect(() => {
    void window.lingxiDesktop?.info().then(setDesktopInfo);
  }, []);
  const [runtime, setRuntime] = useState<SetupStatus | null>(null);
  const [lingxi, setLingxi] = useState<SetupInspection['lingxi'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [check, setCheck] = useState<CodexCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [action, setAction] = useState<CodexSetupAction | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const retryRequest = useRef<CodexSetupRequest | null>(null);
  const popup = useRef<Window | null>(null);
  const openedUrl = useRef('');
  const busy = submitting || !!(action && !finished(action));

  const inspectEnvironment = useCallback(async (signal?: AbortSignal, selectStep = false) => {
    setLoading(true);
    setError('');
    try {
      const [inspection, actionResponse] = await Promise.all([
        seeded.current
          ? Promise.resolve(seeded.current)
          : fetch('/api/setup/check', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
              signal: signal ?? AbortSignal.timeout(25000),
            }).then(async (response) => {
              if (!response.ok) throw new Error('setup unavailable');
              return setupInspectionSchema.parse(await response.json());
            }),
        fetch('/api/setup/codex/action', { cache: 'no-store', ...(signal ? { signal } : {}) }),
      ]);
      if (!actionResponse.ok) throw new Error('setup unavailable');
      if (signal?.aborted) return;
      seeded.current = null;
      const current = codexSetupStateSchema.parse(await actionResponse.json()).action;
      setRuntime(inspection.environment);
      setLingxi(inspection.lingxi);
      setWake(inspection.wake);
      setMicrophone(inspection.microphone);
      setCheck(inspection.codex);
      setAction(current && !finished(current) ? current : null);
      if (selectStep)
        setStep(
          inspection.codex.status !== 'ready'
            ? 0
            : inspection.lingxi.status !== 'configured'
              ? 1
              : 2,
        );
    } catch {
      if (!signal?.aborted) setError('未收到检测结果，请确认本地服务仍在运行后重试。');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  const voiceChanged = useCallback(
    (value: VoiceState) => {
      if (value.wake.installed && !modelObserved.current) {
        modelObserved.current = true;
        void inspectEnvironment(undefined, false);
      }
    },
    [inspectEnvironment],
  );
  async function requestMicrophone() {
    try {
      if (!(await window.lingxiDesktop?.microphone())) throw new Error('permission denied');
      await inspectEnvironment(undefined, false);
    } catch {
      setError('系统尚未允许麦克风，请在系统设置 → 隐私与安全性 → 麦克风中检查 Lingxi。');
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void inspectEnvironment(
      controller.signal,
      selectMissing && !sections.includes(location.hash.slice(1)),
    );
    return () => controller.abort();
  }, [inspectEnvironment, selectMissing]);

  useEffect(() => {
    if (!action || finished(action)) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/setup/codex/action', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('action unavailable');
        const current = codexSetupStateSchema.parse(await response.json()).action;
        setAction(current);
        setError('');
      } catch {
        if (!controller.signal.aborted) {
          setError('暂时无法获取操作进度；本地操作可能仍在继续。正在重试。');
          setAction({ ...action });
        }
      }
    }, 800);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [action]);

  useEffect(() => {
    if (!action || !finished(action)) return;
    popup.current?.close();
    popup.current = null;
    if (action.state === 'succeeded' && action.check) {
      setCheck(action.check);
      return;
    }
    const controller = new AbortController();
    void readCheck(controller.signal)
      .then(setCheck)
      .catch(() => {
        if (!controller.signal.aborted)
          setError('操作已结束，但未收到复查结果，请重新检测 Codex。');
      });
    return () => controller.abort();
  }, [action]);

  useEffect(() => {
    if (action?.authUrl && window.lingxiDesktop && openedUrl.current !== action.authUrl) {
      openedUrl.current = action.authUrl;
      window.open(action.authUrl, '_blank');
      return;
    }
    if (
      action?.authUrl &&
      popup.current &&
      !popup.current.closed &&
      openedUrl.current !== action.authUrl
    ) {
      openedUrl.current = action.authUrl;
      popup.current.location.href = action.authUrl;
    }
  }, [action]);

  async function inspectCodex() {
    setChecking(true);
    setError('');
    try {
      setCheck(await readCheck());
    } catch {
      setError('未收到检测结果，请确认本地服务仍在运行后重试。');
    } finally {
      setChecking(false);
    }
  }
  async function start(kind: CodexSetupRequest['kind']) {
    setSubmitting(true);
    setError('');
    if (kind === 'login') {
      popup.current = window.open('about:blank', '_blank');
      if (popup.current) popup.current.opener = null;
      openedUrl.current = '';
    }
    const request =
      retryRequest.current?.kind === kind
        ? retryRequest.current
        : { requestId: crypto.randomUUID(), kind };
    retryRequest.current = request;
    try {
      const response = await fetch('/api/setup/codex/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok && response.status !== 409) throw new Error('action unavailable');
      const current = codexSetupStateSchema.parse(await response.json()).action;
      setAction(current);
      if (kind === 'login' && current?.kind !== 'login') {
        popup.current?.close();
        popup.current = null;
      }
      retryRequest.current = null;
    } catch {
      popup.current?.close();
      popup.current = null;
      setError('未能确认操作是否开始。可以重试，同一次请求不会重复执行。');
    } finally {
      setSubmitting(false);
    }
  }
  async function cancel() {
    if (!action) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/setup/codex/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: action.id }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('cancel unavailable');
      setAction(codexSetupStateSchema.parse(await response.json()).action);
    } catch {
      setError('未能确认停止结果，请重试。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="workbench setup">
      <header className="settings-topbar">
        <nav className="settings-navigation" aria-label="连接向导导航">
          <div className="settings-navigation-start">
            <ConfigurationButton type="button" onClick={onContinue}>
              <ArrowLeft size={16} aria-hidden="true" />
              返回工作台
            </ConfigurationButton>
            <span className="settings-navigation-divider" aria-hidden="true" />
            <div className="brand">
              <span className="brand-mark">
                <SparklesIcon />
              </span>
              <span>
                丽塔同学 <span className="brand-detail">/ 连接向导</span>
              </span>
            </div>
          </div>
        </nav>
      </header>
      <section className="intro">
        <h1>配置与连接</h1>
        <p className="intro-detail">
          根据这台电脑的实际状态，准备 Codex、丽塔同学、唤醒模型与麦克风权限。
        </p>
      </section>
      {loading && !runtime ? (
        <div className="panel setup-result" role="status">
          <strong>正在检查 Codex、丽塔同学和语音唤醒…</strong>
          <p>检查本地配置、模型文件和原生检测库，不自动下载、登录、连接语音或打开麦克风。</p>
        </div>
      ) : !runtime || (!check && (!action || finished(action))) ? (
        <div className="panel setup-result">
          <p role="alert">{error}</p>
          <ConfigurationButton
            type="button"
            className="button secondary"
            onClick={() =>
              void inspectEnvironment(
                undefined,
                selectMissing && !sections.includes(location.hash.slice(1)),
              )
            }
          >
            重新检查环境
          </ConfigurationButton>
        </div>
      ) : (
        <>
          <div className="settings-overview-heading">
            <h2>配置概览</h2>
            <ConfigurationButton
              type="button"
              disabled={busy || loading}
              onClick={() => void inspectEnvironment(undefined, false)}
            >
              <RefreshCw size={16} aria-hidden="true" />
              {loading ? '正在检查全部配置…' : '重新检查全部配置'}
            </ConfigurationButton>
          </div>
          <div className="setup-scope">
            <strong>环境检查已完成</strong> ·{' '}
            {runtime.host.platform === 'darwin' ? 'macOS' : runtime.host.platform} ·{' '}
            {runtime.host.arch} · Node.js {runtime.host.nodeVersion}
            {desktopInfo && (
              <span>
                {' '}
                · 系统 {desktopInfo.systemVersion}（{desktopInfo.arch}）
              </span>
            )}
            {!runtime.host.nodeSupported && <p>请使用 Node.js 24.x 重新启动服务。</p>}
            {runtime.host.platform !== 'darwin' && (
              <p>检测来自服务所在电脑；连接 Mac 时，请在 Mac 上运行本地服务。</p>
            )}
            <p>
              {runtime.capabilities.codexTasks
                ? '检查本身不开麦；回到工作台后按已保存偏好自动连接服务和本地唤醒，仍需模型及系统麦克风授权。'
                : '当前浏览器入口可保存建议和同步大屏。执行任务、语音和本地唤醒请使用桌面版。'}
            </p>
          </div>
          <section className="setup-overview" aria-label="环境检查结果">
            <div className="panel">
              <p className="eyebrow">Codex</p>
              <h2>{check ? codexMessages[check.status].title : '操作进行中'}</h2>
            </div>
            <div className="panel">
              <p className="eyebrow">丽塔同学 AI</p>
              <h2>
                {lingxi?.status === 'configured'
                  ? '丽塔同学配置已保存'
                  : lingxi?.status === 'not-configured'
                    ? '需要绑定丽塔同学设备'
                    : lingxi?.reason === 'secure-storage-unavailable'
                      ? '无法读取丽塔同学本机配置'
                      : '需在桌面版检测丽塔同学'}
              </h2>
            </div>
            <div className="panel">
              <p className="eyebrow">语音唤醒</p>
              <h2>
                {wake?.status === 'ready'
                  ? '唤醒模型检查通过'
                  : wake?.reason === 'native-unavailable'
                    ? '唤醒检测库不可用'
                    : wake?.reason === 'desktop-required'
                      ? '需在桌面版检测唤醒'
                      : '需要下载唤醒模型'}
              </h2>
            </div>
          </section>
          <main className="setup-layout">
            <nav className="setup-steps" aria-label="设置分类">
              {titles.map((title, index) => (
                <ConfigurationButton
                  type="button"
                  key={title}
                  aria-current={step === index ? 'step' : undefined}
                  onClick={() => {
                    setStep(index);
                    history.replaceState(null, '', `/setup#${sections[index]}`);
                  }}
                >
                  <span className="step-number">0{index + 1}</span>
                  <span>{title}</span>
                </ConfigurationButton>
              ))}
            </nav>
            <section className="panel setup-content" aria-labelledby="setup-step-title">
              <h2 id="setup-step-title">{titles[step]}</h2>
              {step === 0 ? (
                <>
                  {check && (
                    <div
                      className={`setup-result ${check.status === 'ready' ? 'verified' : ''}`}
                      role="status"
                    >
                      <strong>{codexMessages[check.status].title}</strong>
                      <p>{codexMessages[check.status].detail}</p>
                      {check.cliVersion && (
                        <p>
                          CLI {check.cliVersion} ·{' '}
                          {check.authentication === 'chatgpt'
                            ? 'ChatGPT 登录'
                            : check.authentication === 'api-key'
                              ? 'API Key 登录'
                              : check.authentication === 'provider'
                                ? '模型提供方配置'
                                : '未确认登录'}
                        </p>
                      )}
                      <p className="muted">
                        本次检查：{new Date(check.checkedAt).toLocaleString()}
                      </p>
                    </div>
                  )}
                  {check?.status === 'not-installed' && (
                    <>
                      <p>
                        下载稳定通道的最新版，安装到工作台自己的工具目录。无需管理员权限，保留已有全局安装。
                      </p>
                      <ConfigurationButton
                        type="button"
                        className="button secondary"
                        disabled={busy || checking}
                        onClick={() => void start('install')}
                      >
                        一键安装最新版 Codex
                      </ConfigurationButton>
                    </>
                  )}
                  {check?.status === 'signed-out' && (
                    <>
                      <p>打开官方授权页完成登录。工作台不接收你的密码或密钥。</p>
                      <ConfigurationButton
                        type="button"
                        className="button secondary"
                        disabled={busy || checking}
                        onClick={() => void start('login')}
                      >
                        在浏览器登录 Codex
                      </ConfigurationButton>
                    </>
                  )}
                  {action && (
                    <div className="setup-result" role="status">
                      <strong>{actionLabels[action.state]}</strong>
                      {action.error && <p>{errors[action.error]}</p>}
                      {action.state === 'succeeded' && action.kind === 'install' && (
                        <p>
                          已安装 CLI {action.check?.cliVersion}，并完成接口检查。
                          {action.check?.status === 'signed-out' ? '下一步请登录。' : ''}
                        </p>
                      )}
                      {action.state === 'succeeded' && action.kind === 'login' && (
                        <p>官方授权已完成，认证配置复查通过。</p>
                      )}
                      {action.authUrl && (
                        <ExternalLink href={action.authUrl}>打开官方授权页</ExternalLink>
                      )}
                      {!finished(action) && (
                        <ConfigurationButton
                          className="button secondary"
                          type="button"
                          disabled={submitting || action.state === 'cancelling'}
                          onClick={() => void cancel()}
                        >
                          {action.kind === 'login' ? '停止等待登录' : '停止安装'}
                        </ConfigurationButton>
                      )}
                      {action.state === 'cancelled' && (
                        <p>停止操作不撤销已经完成的安装或账号授权。</p>
                      )}
                    </div>
                  )}
                  <p>
                    <ConfigurationButton
                      className="button secondary"
                      type="button"
                      disabled={busy || checking}
                      onClick={() => void inspectCodex()}
                    >
                      {checking ? '正在检测 Codex…' : '重新检测 Codex'}
                    </ConfigurationButton>
                  </p>
                  {error && (
                    <p className="error" role="alert">
                      {error}
                    </p>
                  )}
                  <details>
                    <summary>使用终端配置或排查问题</summary>
                    <p>也可自行安装稳定通道最新版；已有 CLI 时先检查，不必重新安装。</p>
                    <Command>{`npm install -g ${CODEX_SETUP_PACKAGE}`}</Command>
                    <Command>
                      {'codex --version\ncodex login status\n# 未登录时再执行\ncodex login'}
                    </Command>
                    <p>
                      检测会短暂启动 App Server，读取认证配置后关闭。已有 CLI
                      不会自动升级。网页按钮安装的 CLI 由工作台管理，终端里的 codex
                      可能是另一份安装。
                    </p>
                    <p>
                      找不到已有 CLI 时，运行 <code>command -v codex</code>
                      ，从相同终端重启工作台；也可在服务启动时用 <code>LINGXI_CODEX_BIN</code>{' '}
                      指定可执行文件的绝对路径。
                    </p>
                  </details>
                  <ExternalLink href="https://developers.openai.com/codex/app-server/">
                    Codex 官方接入说明
                  </ExternalLink>
                </>
              ) : step === 1 ? (
                <>
                  <VoiceControls configuration variant="connection" />
                  <p className="voice-setup-help">
                    首次使用先完成官方账号与智能体配置，再申请本机绑定码。不需要单独安装音频客户端。
                  </p>
                  <ExternalLink href="https://linx.qiniu.com/docs/xrobot/platform/OTA">
                    官方设备绑定协议
                  </ExternalLink>
                </>
              ) : (
                <>
                  <p>先准备本地模型与麦克风权限，再选择是否自动监听唤醒词。</p>
                  {wake?.reason === 'native-unavailable' && (
                    <p role="alert">
                      模型文件存在，但本机检测库未能加载。请重新安装对应架构的桌面包；从源码运行时重新执行
                      npm ci 后重启，再复查。
                    </p>
                  )}
                  <VoiceControls configuration variant="wake" onState={voiceChanged} />
                  <h3>麦克风权限</h3>
                  <p role="status">
                    {microphone === 'granted'
                      ? '麦克风权限已允许；是否自动待唤醒由上方开关决定。'
                      : microphone === 'not-determined'
                        ? '尚未请求麦克风权限；可现在授权，也可首次收音时授权。'
                        : ['denied', 'restricted'].includes(microphone)
                          ? '麦克风权限被系统阻止，请在系统设置 → 隐私与安全性 → 麦克风中允许 Lingxi。'
                          : '尚未确认麦克风权限，请在桌面版检查。'}
                  </p>
                  {window.lingxiDesktop && microphone !== 'granted' && (
                    <ConfigurationButton
                      className="button secondary"
                      type="button"
                      onClick={() => void requestMicrophone()}
                    >
                      授权麦克风
                    </ConfigurationButton>
                  )}
                  {error && <p role="alert">{error}</p>}
                </>
              )}
            </section>
          </main>
        </>
      )}
    </div>
  );
}
