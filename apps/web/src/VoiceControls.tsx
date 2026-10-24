import { type VoiceState, voiceStateSchema, type WorkbenchState } from '@lingxi/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { MicrophoneIcon } from './MicrophoneIcon';

async function command(action: string, values: Record<string, unknown> = {}) {
  const response = await fetch('/api/voice/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...values }),
  });
  if (!response.ok) throw new Error('voice unavailable');
  return voiceStateSchema.parse(await response.json());
}
const labels: Record<VoiceState['status'], string> = {
  disconnected: '语音未连接 · 麦克风已关闭',
  connecting: '正在连接灵矽 · 麦克风已关闭',
  ready: '灵矽已连接 · 麦克风关闭',
  listening: '收音中 · 麦克风已开启',
  speaking: '灵矽正在播报 · 麦克风已关闭',
  failed: '语音连接失败 · 麦克风已关闭',
};
export function voicePresentation(state: VoiceState | null, task: WorkbenchState['task']) {
  if (!state) return { label: '正在读取语音状态', submitted: false };
  if (
    ['armed', 'detected'].includes(state.wake.status) &&
    ['ready', 'speaking'].includes(state.status)
  )
    return {
      label:
        state.status === 'speaking'
          ? '播报中 · 本地麦克风开启，暂停唤醒'
          : `本地待唤醒 · 麦克风已开启 · ${state.wake.keyword}`,
      submitted: false,
    };
  const working = task && !['completed', 'failed', 'interrupted'].includes(task.status);
  const submitted = !!working && state.status === 'ready' && state.captureId === task.id;
  const activity =
    task?.status === 'waiting'
      ? '等待确认'
      : task?.status === 'queued'
        ? '等待执行'
        : task?.status === 'stopping'
          ? '正在停止'
          : '正在制作';
  if (state.status === 'ready')
    return {
      label: working
        ? `${submitted ? '已提交 · ' : ''}${activity} · 麦克风已关闭`
        : '待唤醒 · 麦克风已关闭',
      submitted,
    };
  return {
    label:
      state.status === 'disconnected' && working
        ? `${activity} · ${labels.disconnected}`
        : labels[state.status],
    submitted: false,
  };
}
export function VoiceControls({
  configuration = false,
  onDraft,
  prepare,
  onState,
  variant = 'all',
  listenUnavailable,
  task = null,
}: {
  configuration?: boolean;
  prepare?: () => Promise<void>;
  onDraft?: (text: string, id: string) => void;
  onState?: (value: VoiceState) => void;
  variant?: 'all' | 'connection' | 'wake';
  listenUnavailable?: string | undefined;
  task?: WorkbenchState['task'] | undefined;
}) {
  const [state, setState] = useState<VoiceState | null>(null),
    [error, setError] = useState('');
  const [binding, setBinding] = useState<{
    status: string;
    deviceId: string | null;
    code: string | null;
    error: string | null;
  } | null>(null);
  const [bindingBusy, setBindingBusy] = useState(false);
  async function bind(action: 'start' | 'check' | 'cancel') {
    setBindingBusy(true);
    try {
      const response = await fetch('/api/voice/binding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error();
      setBinding(
        z
          .object({
            status: z.string(),
            deviceId: z.string().nullable(),
            code: z.string().nullable(),
            error: z.string().nullable(),
          })
          .parse(await response.json()),
      );
    } catch {
      setError('绑定操作未完成，请重试。');
    } finally {
      setBindingBusy(false);
    }
  }
  const [token, setToken] = useState(''),
    [deviceId, setDeviceId] = useState(''),
    [allow, setAllow] = useState(false);
  const [keyword, setKeyword] = useState('丽塔同学');
  const [operating, setOperating] = useState(false);
  const inOperation = useRef(false),
    wakeActive = useRef(false),
    lastWake = useRef('');
  const suppressUntil = useRef(0);
  const startCapture = useRef<(action: string) => Promise<void>>(async () => {});
  const clientId = useRef(crypto.randomUUID());
  const stream = useRef<MediaStream | null>(null),
    capture = useRef<AudioContext | null>(null),
    recording = useRef(false);
  const playback = useRef<AudioContext | null>(null),
    scheduled = useRef(0),
    sources = useRef(new Set<AudioBufferSourceNode>());
  const lastDraft = useRef('');
  const stopMic = useCallback(() => {
    recording.current = false;
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    void capture.current?.close();
    capture.current = null;
  }, []);
  const resetPlayback = useCallback(() => {
    for (const source of sources.current) {
      try {
        source.stop();
      } catch {
        /* Ended. */
      }
    }
    sources.current.clear();
    scheduled.current = 0;
  }, []);
  useEffect(() => {
    let active = true;
    const update = async () => {
      try {
        const response = await fetch('/api/voice');
        if (!response.ok) return;
        const value = voiceStateSchema.parse(await response.json());
        if (active) setState(value);
      } catch {
        /* Keep previous status until reconnection. */
      }
    };
    void fetch('/api/voice/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then(update)
      .catch(() => {});
    const timer = setInterval(() => void update(), 700);
    const unsubscribe = window.lingxiDesktop?.onAudio((value) => {
      if (value.reset) {
        resetPlayback();
        return;
      }
      const context = playback.current;
      if (!value.pcm || !context || context.state === 'closed') return;
      const bytes = Uint8Array.from(atob(value.pcm), (c) => c.charCodeAt(0));
      const samples = new DataView(bytes.buffer),
        buffer = context.createBuffer(1, bytes.length / 2, value.sampleRate ?? 16000),
        channel = buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i++) channel[i] = samples.getInt16(i * 2, true) / 32768;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const time = Math.max(context.currentTime + 0.03, scheduled.current);
      if (time - context.currentTime > 30) {
        setError('语音播放积压，请停止播报后重试。');
        return;
      }
      source.start(time);
      scheduled.current = time + buffer.duration;
      sources.current.add(source);
      source.onended = () => sources.current.delete(source);
    });
    return () => {
      active = false;
      clearInterval(timer);
      unsubscribe?.();
      stopMic();
      if (wakeActive.current) void command('stop-wake').catch(() => {});
      resetPlayback();
      void playback.current?.close();
      playback.current = null;
    };
  }, [stopMic, resetPlayback]);
  useEffect(() => {
    if (state) onState?.(state);
    if (!inOperation.current && state) {
      if (['off', 'failed'].includes(state.wake.status)) wakeActive.current = false;
      if (state.status !== 'listening' && !wakeActive.current && recording.current) stopMic();
    }
    if (
      state?.wake.status === 'detected' &&
      state.wake.detectionId &&
      wakeActive.current &&
      state.wake.detectionId !== lastWake.current &&
      !inOperation.current
    ) {
      lastWake.current = state.wake.detectionId;
      const context = playback.current;
      if (context) {
        const tone = context.createOscillator(),
          gain = context.createGain();
        tone.frequency.value = 880;
        gain.gain.value = 0.08;
        tone.connect(gain).connect(context.destination);
        tone.start();
        tone.stop(context.currentTime + 0.1);
        suppressUntil.current = Date.now() + 300;
      }
      void startCapture.current('listen');
    }
    if (
      state?.draft &&
      state.captureId &&
      `${state.captureId}:${state.draft}` !== lastDraft.current &&
      onDraft
    ) {
      lastDraft.current = `${state.captureId}:${state.draft}`;
      onDraft(state.draft, state.captureId);
    }
  }, [state, onDraft, onState, stopMic]);
  async function operate(action: string, text?: string) {
    if (inOperation.current) return;
    inOperation.current = true;
    setOperating(true);
    try {
      setError('');
      if (action === 'listen') {
        if (listenUnavailable) {
          setError(listenUnavailable);
          return;
        }
        try {
          await prepare?.();
        } catch {
          setError('项目尚未准备好，请确认项目与连接后重试。');
          return;
        }
      }
      if (['connect', 'speak', 'listen', 'arm-wake'].includes(action)) {
        playback.current ??= new AudioContext();
        await playback.current.resume();
      }
      if (action === 'listen' || action === 'arm-wake') {
        if (action === 'arm-wake') wakeActive.current = true;
        if (!recording.current) {
          if (!(await window.lingxiDesktop?.microphone())) throw new Error('permission');
          const media = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });
          stream.current = media;
          const context = new AudioContext({ sampleRate: 16000 });
          capture.current = context;
          if (context.sampleRate !== 16000) throw new Error('sample rate unsupported');
          await context.audioWorklet.addModule('/pcm-worklet.js');
          const worklet = new AudioWorkletNode(context, 'lingxi-pcm-capture');
          worklet.port.onmessage = (event) => {
            if (recording.current && event.data instanceof ArrayBuffer) {
              const muted = Date.now() < suppressUntil.current || sources.current.size > 0;
              window.lingxiDesktop?.audioFrame(muted ? new ArrayBuffer(640) : event.data);
            }
          };
          context.createMediaStreamSource(media).connect(worklet);
          worklet.connect(context.destination);
        }
        const value = await command(action, action === 'arm-wake' ? { keyword } : {});
        if (action === 'arm-wake' && value.wake.status !== 'armed') throw new Error('wake_failed');
        recording.current = true;
        setState(value);
        await capture.current?.resume();
      } else {
        if (action === 'stop-wake' || action === 'disconnect') wakeActive.current = false;
        if (
          (action === 'stop-listening' && !wakeActive.current) ||
          action === 'disconnect' ||
          action === 'stop-wake'
        )
          stopMic();
        if (action === 'stop-speaking' || action === 'disconnect') resetPlayback();
        setState(await command(action, text ? { text } : {}));
      }
    } catch {
      stopMic();
      wakeActive.current = false;
      if (action === 'listen' || action === 'arm-wake') void command('stop-wake').catch(() => {});
      setError('操作未完成。请检查连接配置、麦克风权限和系统声音设置。');
    } finally {
      inOperation.current = false;
      setOperating(false);
    }
  }
  startCapture.current = (action) => operate(action);
  async function save() {
    try {
      const response = await fetch('/api/voice/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'wss://xrobo-io.qiniuapi.com/v1/ws/',
          deviceId: deviceId.trim(),
          clientId: clientId.current,
          token: token.trim(),
          allowVoiceSubmit: allow,
        }),
      });
      if (!response.ok) throw new Error();
      setState(voiceStateSchema.parse(await response.json()));
      setToken('');
      setError('');
    } catch {
      setError('未能保存。请核对 MAC 地址和令牌；桌面系统须支持加密存储。');
    }
  }
  const presentation = voicePresentation(state, task);
  const WakePanel = configuration ? 'section' : 'details';
  return (
    <section
      className={`voice-controls voice-${state?.status ?? 'disconnected'}${!configuration && presentation.submitted ? ' voice-submitted' : ''}`}
      aria-label="灵矽语音"
    >
      {variant !== 'wake' && (
        <>
          {configuration && (
            <div className="binding-wizard">
              <h3>绑定本机语音设备</h3>
              <p>1. 在七牛官方控制台登录并创建智能体。</p>
              <a href="https://xrobo.qiniu.com/" target="_blank" rel="noreferrer">
                打开灵矽控制台 ↗
              </a>
              <p>2. 申请本机激活码，在控制台的设备绑定入口输入六位数字。</p>
              <button type="button" disabled={bindingBusy} onClick={() => void bind('start')}>
                获取本机绑定码
              </button>
              {binding?.deviceId && <p>本机设备标识：{binding.deviceId}</p>}
              {binding?.code && (
                <p className="binding-code" role="status" aria-label="设备激活码">
                  {binding.code}
                </p>
              )}
              <p>3. 在官方页面完成绑定后，点击检查；向导自动获取连接信息并加密保存。</p>
              <button
                type="button"
                disabled={bindingBusy || !binding?.deviceId}
                onClick={() => void bind('check')}
              >
                我已绑定，检查连接配置
              </button>
              <button type="button" onClick={() => void bind('cancel')}>
                停止绑定检查
              </button>
              {binding?.status === 'bound' && (
                <p role="status">
                  绑定已确认，连接配置已加密保存。现在可以连接灵矽并测试收音与播报。
                </p>
              )}
              {binding?.status === 'waiting' && (
                <p>等待官方控制台完成设备绑定。激活码失效时可重新获取。</p>
              )}
              {binding?.error && <p role="alert">{binding.error}</p>}
            </div>
          )}
          {configuration && (
            <details>
              <summary>高级：手动配置已绑定设备</summary>
              <p>
                在灵矽控制台创建智能体并绑定本机设备，获取设备 WebSocket 令牌。此处使用官方 PCM
                16kHz 单声道协议；如果服务只返回 Opus，会明确提示协议不兼容。
              </p>
              <label>
                已绑定设备的 MAC 地址
                <input
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  placeholder="aa:bb:cc:dd:ee:ff"
                  autoComplete="off"
                />
              </label>
              <label>
                设备访问令牌
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={allow}
                  onChange={(e) => setAllow(e.target.checked)}
                />
                允许主动收音后，通过灵矽 MCP 提交或停止 Codex 任务
              </label>
              <p>
                令牌仅在本机加密保存。普通转写保留为草稿；开启语音提交后，每次主动收音最多提交一个任务，30
                秒后不再接受工具指令。自动唤醒需另行明确开启，本地等待音频不会上传。
              </p>
              <button type="button" disabled={!token || !deviceId} onClick={() => void save()}>
                保存设备配置
              </button>
            </details>
          )}
          {configuration && state?.configured && (
            <label>
              <input
                type="checkbox"
                checked={state.allowVoiceSubmit}
                onChange={async (e) => {
                  try {
                    const response = await fetch('/api/voice/preferences', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ allowVoiceSubmit: e.target.checked }),
                    });
                    if (!response.ok) throw new Error();
                    setState(voiceStateSchema.parse(await response.json()));
                  } catch {
                    setError('未能保存语音提交设置。');
                  }
                }}
              />
              允许主动收音后用语音提交/停止任务、切换计划模式（保存后需重新连接）
            </label>
          )}
          <p role="status" className="voice-status">
            <MicrophoneIcon
              muted={
                state?.status !== 'listening' &&
                !['armed', 'detected'].includes(state?.wake.status ?? '')
              }
            />
            {configuration && state && !['armed', 'detected'].includes(state.wake.status)
              ? labels[state.status]
              : presentation.label}
          </p>
          <div className="live-actions">
            {(configuration ||
              (state?.configured && ['disconnected', 'failed'].includes(state.status))) && (
              <button
                type="button"
                disabled={!state?.configured || !['disconnected', 'failed'].includes(state.status)}
                onClick={() => void operate('connect')}
              >
                连接灵矽
              </button>
            )}
            {!configuration && state && !state.configured && <a href="/setup">连接设置</a>}
            {state && ['ready', 'speaking'].includes(state.status) && (
              <button
                type="button"
                disabled={operating || !!listenUnavailable}
                title={listenUnavailable}
                onClick={() => void operate('listen')}
              >
                开始收音
              </button>
            )}
            {state?.status === 'listening' && (
              <button type="button" onClick={() => void operate('stop-listening')}>
                结束收音
              </button>
            )}
            {configuration && state && !['disconnected', 'failed'].includes(state.status) && (
              <button type="button" onClick={() => void operate('disconnect')}>
                断开语音
              </button>
            )}
            {!configuration && state && !['disconnected', 'failed'].includes(state.status) && (
              <details className="voice-more">
                <summary aria-label="更多语音操作" title="更多语音操作">
                  ⋯
                </summary>
                <div>
                  <button type="button" onClick={() => void operate('disconnect')}>
                    断开语音
                  </button>
                </div>
              </details>
            )}
            {configuration && (
              <button
                type="button"
                disabled={!state || !['ready', 'speaking'].includes(state.status)}
                onClick={() => void operate('speak', '灵矽已连接，现在可以开始共创。')}
              >
                测试播报
              </button>
            )}
            {(configuration || state?.status === 'speaking') && (
              <button
                type="button"
                disabled={state?.status !== 'speaking'}
                onClick={() => void operate('stop-speaking')}
              >
                停止播报
              </button>
            )}
          </div>
        </>
      )}
      {variant !== 'connection' && (
        <WakePanel className="wake-settings">
          {configuration ? <h3>本地唤醒模型</h3> : <summary>语音唤醒</summary>}
          {configuration && (
            <p>
              下载一次后离线检测，无需额外账号。完成后回工作台开启唤醒，默认词为“丽塔同学”，可在那里修改。
            </p>
          )}
          {!configuration && (
            <>
              <p>
                开启后麦克风持续在本机检测；说出唤醒词、听到提示音后再说指令，停顿约 1.2
                秒结束收音。待唤醒音频不上传、不保存。播报期间暂停检测；退出或刷新页面后需重新开启。
              </p>
              <label>
                中文唤醒词
                <input
                  value={keyword}
                  maxLength={12}
                  disabled={operating || wakeActive.current}
                  onChange={(event) => setKeyword(event.target.value)}
                />
              </label>
            </>
          )}
          {!state?.wake.installed && (
            <button
              type="button"
              className={configuration ? 'button secondary' : undefined}
              disabled={operating || state?.wake.status === 'installing'}
              onClick={() => void operate('install-wake')}
            >
              {state?.wake.status === 'installing'
                ? '正在下载模型…'
                : '下载本地唤醒模型（约 33 MB）'}
            </button>
          )}
          {state?.wake.installed && configuration && (
            <p role="status">模型文件已下载。复查配置后，回到工作台开启语音唤醒。</p>
          )}
          {!configuration &&
            state?.wake.installed &&
            !['armed', 'detected', 'loading'].includes(state.wake.status) && (
              <button
                type="button"
                disabled={
                  configuration ||
                  operating ||
                  state.status !== 'ready' ||
                  !/^[\u4e00-\u9fff]{2,12}$/.test(keyword)
                }
                onClick={() => void operate('arm-wake')}
              >
                开启语音唤醒
              </button>
            )}
          {state && ['armed', 'detected', 'loading'].includes(state.wake.status) && (
            <button type="button" disabled={operating} onClick={() => void operate('stop-wake')}>
              关闭语音唤醒
            </button>
          )}
          {state?.wake.error && <p role="alert">{state.wake.error}</p>}
        </WakePanel>
      )}
      {state?.subtitle && <p>{state.subtitle}</p>}
      {configuration && state?.draft && <p>转写草稿：{state.draft}</p>}
      {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
    </section>
  );
}
