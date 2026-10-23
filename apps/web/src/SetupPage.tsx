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
} from '@lingxi/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

const steps = ['配置 Codex', '配置灵矽'];
const finished = (action: CodexSetupAction) =>
  ['succeeded', 'failed', 'cancelled'].includes(action.state);
const codexMessages: Record<CodexCheck['status'], { title: string; detail: string }> = {
  ready: {
    title: 'Codex 环境检查通过',
    detail: 'CLI、App Server 与认证配置可用，可以继续配置灵矽。当前版本仍未开放执行任务。',
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
        <button type="button" onClick={copy}>
          复制命令
        </button>
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

export function SetupPage() {
  const [step, setStep] = useState(0);
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

  const inspectEnvironment = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const [hostResponse, actionResponse] = await Promise.all([
        fetch('/api/setup/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: signal ?? AbortSignal.timeout(25000),
        }),
        fetch('/api/setup/codex/action', { cache: 'no-store', ...(signal ? { signal } : {}) }),
      ]);
      if (!hostResponse.ok || !actionResponse.ok) throw new Error('setup unavailable');
      const inspection = setupInspectionSchema.parse(await hostResponse.json());
      const current = codexSetupStateSchema.parse(await actionResponse.json()).action;
      setRuntime(inspection.environment);
      setLingxi(inspection.lingxi);
      setCheck(inspection.codex);
      setAction(current && !finished(current) ? current : null);
      setStep(inspection.codex.status === 'ready' ? 1 : 0);
    } catch {
      if (!signal?.aborted) setError('未收到检测结果，请确认本地服务仍在运行后重试。');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void inspectEnvironment(controller.signal);
    return () => controller.abort();
  }, [inspectEnvironment]);

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
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">灵</span>
          <span>
            灵矽 <span className="brand-detail">/ 连接向导</span>
          </span>
        </a>
        <a className="button secondary" href="/">
          返回工作台
        </a>
      </header>
      <section className="intro">
        <p className="eyebrow">连接你的工具</p>
        <h1>先检查，再配置。</h1>
        <p className="intro-detail">根据这台电脑的实际状态，准备 Codex 和灵矽。</p>
      </section>
      {loading ? (
        <div className="panel setup-result" role="status">
          <strong>正在检查 Codex 和灵矽…</strong>
          <p>检查本地环境与两项集成的可检测状态，不安装软件或发起登录。</p>
        </div>
      ) : !runtime || (!check && (!action || finished(action))) ? (
        <div className="panel setup-result">
          <p role="alert">{error}</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => void inspectEnvironment()}
          >
            重新检查环境
          </button>
        </div>
      ) : (
        <>
          <div className="setup-scope">
            <strong>环境检查已完成</strong> ·{' '}
            {runtime.host.platform === 'darwin' ? 'macOS' : runtime.host.platform} ·{' '}
            {runtime.host.arch} · Node.js {runtime.host.nodeVersion}
            {!runtime.host.nodeSupported && <p>请使用 Node.js 24.x 重新启动服务。</p>}
            {runtime.host.platform !== 'darwin' && (
              <p>检测来自服务所在电脑；连接 Mac 时，请在 Mac 上运行本地服务。</p>
            )}
            <p>当前可保存建议和同步大屏。自动修改代码与灵矽语音控制尚未开放。</p>
          </div>
          <section className="setup-overview" aria-label="环境检查结果">
            <div className="panel">
              <p className="eyebrow">Codex</p>
              <h2>{check ? codexMessages[check.status].title : '操作进行中'}</h2>
              <p>{check ? codexMessages[check.status].detail : '正在准备本地接口。'}</p>
            </div>
            <div className="panel">
              <p className="eyebrow">灵矽 AI</p>
              <h2>{lingxi?.status === 'unavailable' ? '暂无法检测灵矽' : '等待检查'}</h2>
              <p>检测接口尚未接入，无法确认账号和设备状态。可继续按下方步骤准备。</p>
            </div>
          </section>
          <main className="setup-layout">
            <nav className="setup-steps" aria-label="连接步骤">
              {steps.map((title, index) => (
                <button
                  type="button"
                  key={title}
                  aria-current={step === index ? 'step' : undefined}
                  onClick={() => setStep(index)}
                >
                  <span className="step-number">0{index + 1}</span>
                  <span>{title}</span>
                </button>
              ))}
            </nav>
            <section className="panel setup-content" aria-labelledby="setup-step-title">
              <p className="eyebrow">步骤 {step + 1} / 2</p>
              <h2 id="setup-step-title">{steps[step]}</h2>
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
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy || checking}
                        onClick={() => void start('install')}
                      >
                        一键安装最新版 Codex
                      </button>
                    </>
                  )}
                  {check?.status === 'signed-out' && (
                    <>
                      <p>打开官方授权页完成登录。工作台不接收你的密码或密钥。</p>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy || checking}
                        onClick={() => void start('login')}
                      >
                        在浏览器登录 Codex
                      </button>
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
                        <button
                          className="button secondary"
                          type="button"
                          disabled={submitting || action.state === 'cancelling'}
                          onClick={() => void cancel()}
                        >
                          {action.kind === 'login' ? '停止等待登录' : '停止安装'}
                        </button>
                      )}
                      {action.state === 'cancelled' && (
                        <p>停止操作不撤销已经完成的安装或账号授权。</p>
                      )}
                    </div>
                  )}
                  <p>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={busy || checking}
                      onClick={() => void inspectCodex()}
                    >
                      {checking ? '正在检测 Codex…' : '重新检测 Codex'}
                    </button>
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
              ) : (
                <>
                  <div className="setup-result" role="status">
                    <strong>灵矽连接尚未验证</strong>
                    <p>工作台尚未接入灵矽检测接口，暂时无法自动确认账号、客户端和设备绑定状态。</p>
                  </div>
                  <h3>1. 准备账号与智能体</h3>
                  <p>
                    已有账号和智能体可直接使用；尚未准备时，在七牛灵矽控制台注册或登录并创建智能体。
                  </p>
                  <ExternalLink href="https://xrobo.qiniu.com/">打开灵矽控制台</ExternalLink>
                  <h3>2. 运行并绑定 Mac 音频客户端</h3>
                  <p>
                    按官方文档安装 C++ / PortAudio
                    客户端，用设备验证码绑定智能体。已有绑定可跳过这一步。
                  </p>
                  <ExternalLink href="https://linx.qiniu.com/docs/xrobot/guide/client-demo">
                    Mac 音频客户端安装文档
                  </ExternalLink>
                  <ExternalLink href="https://linx.qiniu.com/docs/xrobot/guide/quick-start">
                    智能体与设备绑定步骤
                  </ExternalLink>
                  <h3>3. 确认能听和说</h3>
                  <p>
                    在 macOS「系统设置 → 隐私与安全性 →
                    麦克风」允许客户端录音；说一句测试话，确认有识别结果并能听到回复。
                  </p>
                  <p>完成账号和设备绑定不会自动开启语音编程，还需要接入工作台的任务工具。</p>
                  <ExternalLink href="https://linx.qiniu.com/docs/xrobot/mcp/hardware-mcp">
                    端侧 MCP 工具通道文档
                  </ExternalLink>
                </>
              )}
              <div className="setup-pagination">
                {step === 0 ? (
                  <button className="button secondary" type="button" onClick={() => setStep(1)}>
                    下一步：配置灵矽
                  </button>
                ) : (
                  <>
                    <button className="button secondary" type="button" onClick={() => setStep(0)}>
                      上一步
                    </button>
                    <a className="button secondary" href="/">
                      回到工作台
                    </a>
                  </>
                )}
              </div>
            </section>
          </main>
        </>
      )}
    </div>
  );
}
