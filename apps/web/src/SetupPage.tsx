import {
  CODEX_SETUP_VERSION,
  type CodexCheck,
  codexCheckSchema,
  type SetupStatus,
  setupStatusSchema,
} from '@lingxi/protocol';
import { useEffect, useState } from 'react';

const steps = ['运行工作台', '准备 Codex', '准备灵矽语音', '连接大屏'];
const codexInstall = `npm install -g @openai/codex@${CODEX_SETUP_VERSION}`;
const codexMessages: Record<CodexCheck['status'], { title: string; detail: string }> = {
  ready: {
    title: 'Codex 环境检查通过',
    detail: 'CLI 与 App Server 可用，已读取本机认证配置。当前版本仍未开放执行任务。',
  },
  'not-installed': {
    title: '未找到 Codex CLI',
    detail: '请在这台 Mac 的终端安装 CLI，再从同一终端重新启动工作台。桌面应用可以继续使用。',
  },
  'signed-out': {
    title: 'Codex 尚未登录',
    detail: 'App Server 可以启动。请在终端完成 codex login 后重新检测。',
  },
  failed: {
    title: '未能完成 Codex 检查',
    detail:
      '在终端确认 codex --version 和 codex login status 可以运行，然后重试。自定义安装路径见下方说明。',
  },
  'timed-out': {
    title: 'Codex 检查超时',
    detail: '请在终端确认 CLI 可以正常启动，检查网络后重试。',
  },
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

export function SetupPage() {
  const [step, setStep] = useState(0);
  const [runtime, setRuntime] = useState<SetupStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState(false);
  const [check, setCheck] = useState<CodexCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/setup', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('setup unavailable');
        setRuntime(setupStatusSchema.parse(await response.json()));
      })
      .catch(() => {
        if (!controller.signal.aborted) setRuntimeError(true);
      });
    return () => controller.abort();
  }, []);

  async function inspectCodex() {
    setChecking(true);
    setCheck(null);
    setCheckError('');
    try {
      const response = await fetch('/api/setup/codex/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(25000),
      });
      if (!response.ok) throw new Error('check unavailable');
      setCheck(codexCheckSchema.parse(await response.json()));
    } catch {
      setCheckError('未收到检测结果，请确认本地服务仍在运行后重试。');
    } finally {
      setChecking(false);
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
        <p className="eyebrow">从这台 Mac 开始</p>
        <h1>把准备工作，一步步做好。</h1>
        <p className="intro-detail">
          先运行工作台，再准备 Codex、灵矽语音和大屏。你可以随时回来继续。
        </p>
      </section>
      <p className="setup-scope">
        当前版本支持保存建议和同步大屏。自动修改代码与语音控制尚未开放；本向导帮助检查环境、完成账号和客户端准备。
      </p>
      <main className="setup-layout">
        <nav className="setup-steps" aria-label="连接步骤">
          {steps.map((title, index) => (
            <button
              type="button"
              key={title}
              aria-current={step === index ? 'step' : undefined}
              onClick={() => setStep(index)}
            >
              <span className="step-number">{String(index + 1).padStart(2, '0')}</span>
              <span>{title}</span>
            </button>
          ))}
        </nav>
        <section className="panel setup-content" aria-labelledby="setup-step-title">
          <p className="eyebrow">
            步骤 {step + 1} / {steps.length}
          </p>
          <h2 id="setup-step-title">{steps[step]}</h2>
          {step === 0 && (
            <>
              <p>
                在你的 Mac 上启动本地服务，再用同一台 Mac 的浏览器打开工作台。窗口可以通过 AirPlay
                放到电视上。
              </p>
              <div className="setup-result" role="status">
                {runtime ? (
                  <>
                    <strong>工作台服务已响应</strong>
                    <p>
                      服务所在电脑：
                      {runtime.host.platform === 'darwin' ? 'macOS' : runtime.host.platform} ·{' '}
                      {runtime.host.arch} · Node.js {runtime.host.nodeVersion}
                    </p>
                    {!runtime.host.nodeSupported && <p>请切换到 Node.js 24.x 并重新启动。</p>}
                    {runtime.host.platform !== 'darwin' && (
                      <p>这份检测来自服务所在电脑。要连接你的 Mac，请在 Mac 的终端启动工作台。</p>
                    )}
                  </>
                ) : runtimeError ? (
                  <>
                    <strong>暂时无法读取本地环境</strong>
                    <p>确认服务仍在运行，刷新本页后再试。</p>
                  </>
                ) : (
                  '正在读取本地环境…'
                )}
              </div>
              <h3>第一次从源码启动</h3>
              <p>先安装 Node.js 24.x 和 npm 11.x。以下命令适用于尚未下载过项目的情况。</p>
              <Command>
                {
                  'git clone https://github.com/qiniu-ued/lingxi-product-prototype.git\ncd lingxi-product-prototype\nnpm ci\nnpm run build\nnpm start'
                }
              </Command>
              <p>
                日常打开 <code>http://127.0.0.1:4310/</code>。保留启动服务的终端窗口，按 Ctrl+C
                停止。
              </p>
              <ExternalLink href="https://nodejs.org/en/download">安装 Node.js 24</ExternalLink>
            </>
          )}
          {step === 1 && (
            <>
              <p>
                保留工作台运行，另开一个终端标签页。只有 Codex 桌面应用时，先安装 CLI。
                工作台通过它检查 App Server，并使用该 CLI 的登录状态。
              </p>
              <h3>1. 安装 CLI</h3>
              <Command>{codexInstall}</Command>
              <h3>2. 检查登录</h3>
              <Command>{'codex --version\ncodex login status'}</Command>
              <p>如果显示未登录，再执行下面的命令，在打开的网页中完成登录。登录后重新检测即可。</p>
              <Command>{'codex login'}</Command>
              <h3>3. 从工作台检测</h3>
              <p>检测会短暂启动 App Server，读取登录类型后关闭进程。不会创建任务或修改项目文件。</p>
              <button
                className="button secondary"
                type="button"
                disabled={checking}
                onClick={inspectCodex}
              >
                {checking ? '正在检测 Codex…' : '检测 Codex 环境'}
              </button>
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
                  <p className="muted">本次检查：{new Date(check.checkedAt).toLocaleString()}</p>
                </div>
              )}
              {checkError && (
                <p className="error" role="alert">
                  {checkError}
                </p>
              )}
              <details>
                <summary>安装了 CLI，但工作台找不到？</summary>
                <p>
                  在终端运行 <code>command -v codex</code>
                  。从这个终端重新启动工作台；自定义位置可在启动时设置 <code>LINGXI_CODEX_BIN</code>{' '}
                  为可执行文件的绝对路径。此设置属于本机服务，页面不会接收任意程序路径。
                </p>
              </details>
              <ExternalLink href="https://developers.openai.com/codex/app-server/">
                Codex 官方接入说明
              </ExternalLink>
            </>
          )}
          {step === 2 && (
            <>
              <p>
                还没有灵矽账号时，先完成账号与音频客户端准备。当前工作台尚不能直接录音或调用灵矽。
              </p>
              <h3>1. 创建账号与智能体</h3>
              <p>
                打开七牛灵矽控制台，完成注册或登录，创建一个供工作台使用的智能体。模型与音色可以先使用平台提供的配置。
              </p>
              <ExternalLink href="https://xrobo.qiniu.com/">打开灵矽控制台</ExternalLink>
              <h3>2. 运行 Mac 音频客户端</h3>
              <p>
                官方演示客户端支持 macOS，使用 C++ 和
                PortAudio。先按官方文档安装编译依赖、编译运行，再按客户端提供的验证码把设备绑定到智能体。
              </p>
              <ExternalLink href="https://linx.qiniu.com/docs/xrobot/guide/client-demo">
                Mac 音频客户端安装文档
              </ExternalLink>
              <ExternalLink href="https://linx.qiniu.com/docs/xrobot/guide/quick-start">
                智能体与设备绑定步骤
              </ExternalLink>
              <h3>3. 验证听和说</h3>
              <p>
                在 macOS「系统设置 → 隐私与安全性 →
                麦克风」允许运行客户端的应用录音，检查输入输出设备。先说一句测试话，确认有识别结果并能听到回复。
              </p>
              <div className="setup-result">
                <strong>语音控制尚待接入</strong>
                <p>
                  音频客户端能对话后，还需要把提交、查询、补充和停止任务接入工作台。完成账号和设备绑定不会自动开启语音编程。
                </p>
              </div>
              <ExternalLink href="https://linx.qiniu.com/docs/xrobot/mcp/hardware-mcp">
                端侧 MCP 工具通道文档
              </ExternalLink>
            </>
          )}
          {step === 3 && (
            <>
              <p>先在同一台 Mac 打开操作台和大屏，保存一条建议，确认两个窗口同步。</p>
              <a className="button secondary" href="/display" target="_blank" rel="noreferrer">
                打开大屏 ↗
              </a>
              <h3>通过 AirPlay 放到电视</h3>
              <ol>
                <li>在 Mac 控制中心打开「屏幕镜像」，选择电视或会议室屏幕。</li>
                <li>支持时选择扩展显示，把大屏窗口移过去并全屏。</li>
                <li>电脑保留操作台，继续输入建议。只能镜像时，两块屏幕显示相同画面。</li>
              </ol>
              <p>网页连接状态代表工作台同步连接；电视是否收到画面，需要你在屏幕上确认。</p>
              <div className="setup-result">
                <strong>准备完成后可以体验什么？</strong>
                <p>
                  现在可以保存建议、同步大屏并恢复会话。真实代码修改、作品预览和灵矽语音控制将在后续接入。
                </p>
              </div>
              <a className="button secondary" href="/">
                回到工作台
              </a>
            </>
          )}
          <div className="setup-pagination">
            <button
              className="button secondary"
              type="button"
              disabled={step === 0}
              onClick={() => setStep(step - 1)}
            >
              上一步
            </button>
            {step < steps.length - 1 && (
              <button className="button secondary" type="button" onClick={() => setStep(step + 1)}>
                下一步：{steps[step + 1]}
              </button>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
