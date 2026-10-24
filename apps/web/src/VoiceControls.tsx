import {
  LINGXI_WORKBENCH_ROLE,
  type VoiceState,
  voiceStateSchema,
  type WorkbenchState,
} from '@lingxi/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { MicrophoneIcon } from './MicrophoneIcon';
import { SettingsLink } from './Navigation';
import { VoiceDiagnostics } from './VoiceDiagnostics';
import { VoiceHandoff } from './VoiceHandoff';

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
  connecting: '正在连接丽塔同学 · 麦克风已关闭',
  ready: '丽塔同学已连接 · 麦克风关闭',
  listening: '收音中 · 麦克风已开启 · 最长 60 秒',
  processing: '正在处理这句话 · 麦克风已关闭',
  speaking: '丽塔同学正在播报 · 麦克风已关闭',
  failed: '语音连接失败 · 麦克风已关闭',
};
export const voiceMicrophoneOpen = (state: VoiceState | null) =>
  !!state &&
  (state.conversationActive ||
    state.status === 'listening' ||
    ['armed', 'detected'].includes(state.wake.status));
export const voiceServiceConnected = (state: VoiceState | null) =>
  !!state && ['ready', 'listening', 'processing', 'speaking'].includes(state.status);
export function voiceConnectionLabel(state: VoiceState | null) {
  if (!state) return '服务状态同步中';
  if (state.status === 'connecting') return '服务连接中';
  if (state.status === 'failed')
    return state.connection.nextRetryAt
      ? `服务重连 ${state.connection.attempt}/6`
      : state.connection.exhausted
        ? '服务重连已暂停'
        : '服务连接失败';
  if (state.status === 'disconnected')
    return !state.configured
      ? '服务待绑定'
      : !state.connectionPreference.enabled
        ? '服务已手动断开'
        : '服务未连接';
  return '服务已连接';
}
export function voicePresentation(state: VoiceState | null, task: WorkbenchState['task']) {
  if (!state) return { label: '正在读取语音状态', submitted: false };
  if (state.conversationActive)
    return {
      label:
        state.status === 'ready'
          ? '语音会话开启 · 本机待说话 · 麦克风已开启'
          : state.status === 'processing'
            ? '正在处理这句话 · 语音会话保持开启'
            : state.status === 'speaking'
              ? '丽塔同学正在播报 · 语音会话保持开启'
              : '收音中 · 语音会话保持开启',
      submitted: false,
    };
  if (['armed', 'detected'].includes(state.wake.status))
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
  const keywordEdited = useRef(false);
  const [roleNotice, setRoleNotice] = useState('');
  const [operating, setOperating] = useState(false);
  const [autoNotice, setAutoNotice] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(0);
  const autoAttempted = useRef<number | null>(null),
    explicitlyOff = useRef(false),
    pendingWake = useRef<string | null>(null);
  const automaticWake = useRef<() => Promise<void>>(async () => {});
  const [audioInput, setAudioInput] = useState<{
    label: string;
    echoCancellation: boolean | string | undefined;
    noiseSuppression: boolean | undefined;
    autoGainControl: boolean | undefined;
  } | null>(null);
  const latestVoice = useRef(state);
  latestVoice.current = state;
  const interrupted = useRef<(message: string) => void>(() => {});
  const inOperation = useRef(false),
    operationEpoch = useRef(0),
    pendingCapture = useRef(false),
    conversationOwner = useRef(false),
    lastSpeech = useRef(''),
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
    if (sources.current.size) suppressUntil.current = Date.now() + 600;
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
      const epoch = operationEpoch.current;
      try {
        const response = await fetch('/api/voice');
        if (!response.ok) return;
        const value = voiceStateSchema.parse(await response.json());
        if (active && epoch === operationEpoch.current && !inOperation.current) setState(value);
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
      source.onended = () => {
        sources.current.delete(source);
        if (!sources.current.size)
          suppressUntil.current = Math.max(suppressUntil.current, Date.now() + 600);
      };
    });
    return () => {
      active = false;
      operationEpoch.current++;
      clearInterval(timer);
      unsubscribe?.();
      const hadCapture = recording.current;
      const hadPlayback = sources.current.size > 0;
      stopMic();
      if (conversationOwner.current || pendingCapture.current || wakeActive.current || hadCapture)
        void command('pause-voice', { suspend: false }).catch(() => {});
      if (hadPlayback) void command('stop-speaking').catch(() => {});
      resetPlayback();
      void playback.current?.close();
      playback.current = null;
    };
  }, [stopMic, resetPlayback]);
  useEffect(() => {
    if (state && !keywordEdited.current) setKeyword(state.wake.keyword);
  }, [state]);
  useEffect(() => {
    if (state) onState?.(state);
    if (!inOperation.current && state) {
      if (['off', 'failed'].includes(state.wake.status)) wakeActive.current = false;
      if (
        !state.conversationActive &&
        state.status !== 'listening' &&
        !wakeActive.current &&
        recording.current
      )
        stopMic();
      if (!state.conversationActive) conversationOwner.current = false;
    }
    if (
      state?.wake.status === 'detected' &&
      state.wake.detectionId &&
      wakeActive.current &&
      state.wake.detectionId !== lastWake.current &&
      !inOperation.current
    ) {
      lastWake.current = state.wake.detectionId;
      if (!state.configured || listenUnavailable) {
        setError(
          !state.configured
            ? '已识别唤醒词，请先在设置绑定语音设备；当前仅本地监听，没有上传语音。'
            : (listenUnavailable as string),
        );
        void command('dismiss-wake')
          .then(setState)
          .catch(() => {});
      } else if (state.status === 'ready') {
        pendingWake.current = state.wake.detectionId;
      } else {
        setError(
          state.connectionPreference.enabled
            ? '语音服务尚未连接，请等待连接成功后再说唤醒词。'
            : '语音服务已手动断开，请点击连接；当前仍只在本地监听。',
        );
        void command('dismiss-wake')
          .then(setState)
          .catch(() => {});
      }
    }
    if (pendingWake.current && state?.wake.status !== 'detected') pendingWake.current = null;
    if (
      pendingWake.current &&
      state?.status === 'ready' &&
      wakeActive.current &&
      !inOperation.current
    ) {
      pendingWake.current = null;
      void startCapture.current('listen');
    }
    if (
      state?.conversationActive &&
      state.status === 'ready' &&
      state.speechId &&
      state.speechId !== lastSpeech.current &&
      recording.current &&
      !inOperation.current
    ) {
      lastSpeech.current = state.speechId;
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
  }, [state, onDraft, onState, stopMic, listenUnavailable]);
  async function operate(action: string, text?: string, automatic = false) {
    if (inOperation.current) return;
    const epoch = ++operationEpoch.current;
    const ensureActive = () => {
      if (operationEpoch.current !== epoch) throw new Error('audio_owner_closed');
    };
    inOperation.current = true;
    pendingCapture.current = ['listen', 'start-session', 'arm-wake'].includes(action);
    setOperating(true);
    let prearmed: VoiceState | null = null;
    try {
      setError('');
      if (action === 'listen' || action === 'start-session') {
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
        ensureActive();
      }
      if (automatic) {
        if (explicitlyOff.current) throw new Error('wake_disabled');
        if ((await window.lingxiDesktop?.microphoneStatus?.()) !== 'granted')
          throw new Error('permission_required');
        ensureActive();
        prearmed = await command('arm-wake', {
          keyword: state?.wake.keyword ?? keyword,
          automatic: true,
        });
        ensureActive();
        if (prearmed.wake.status !== 'armed') {
          setState(prearmed);
          throw new Error('wake_unavailable');
        }
      }
      if (
        ['connect', 'speak', 'listen', 'start-session'].includes(action) ||
        (action === 'arm-wake' && !automatic)
      ) {
        playback.current ??= new AudioContext();
        await playback.current.resume();
        ensureActive();
      }
      if (['listen', 'start-session', 'arm-wake'].includes(action)) {
        if (action === 'arm-wake') wakeActive.current = true;
        if (!recording.current) {
          if (!automatic && !(await window.lingxiDesktop?.microphone()))
            throw new Error('permission');
          ensureActive();
          const media = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });
          if (operationEpoch.current !== epoch) {
            for (const track of media.getTracks()) track.stop();
            return;
          }
          stream.current = media;
          const track = media.getAudioTracks()[0];
          if (track?.readyState === 'ended') throw new Error('audio_input_ended');
          if (track) {
            const settings = track.getSettings();
            setAudioInput({
              label: track.label || '系统默认音频输入',
              echoCancellation: settings.echoCancellation,
              noiseSuppression: settings.noiseSuppression,
              autoGainControl: settings.autoGainControl,
            });
            track.onended = () =>
              interrupted.current('音频输入已中断或权限已撤销，请检查麦克风后恢复。');
          }
          const context = new AudioContext({ sampleRate: 16000 });
          capture.current = context;
          if (context.sampleRate !== 16000) throw new Error('sample rate unsupported');
          await context.audioWorklet.addModule('/pcm-worklet.js');
          ensureActive();
          const worklet = new AudioWorkletNode(context, 'lingxi-pcm-capture');
          worklet.port.onmessage = (event) => {
            if (recording.current && event.data instanceof ArrayBuffer) {
              const muted =
                Date.now() < suppressUntil.current ||
                sources.current.size > 0 ||
                latestVoice.current?.status === 'speaking';
              window.lingxiDesktop?.audioFrame(muted ? new ArrayBuffer(640) : event.data);
            }
          };
          context.createMediaStreamSource(media).connect(worklet);
          worklet.connect(context.destination);
        }
        ensureActive();
        const value =
          prearmed ??
          (await command(
            action,
            action === 'arm-wake' ? { keyword: state?.wake.keyword ?? keyword, automatic } : {},
          ));
        if (operationEpoch.current !== epoch) {
          await command('pause-voice', { suspend: false });
          return;
        }
        if (action === 'arm-wake' && value.wake.status !== 'armed') throw new Error('wake_failed');
        if (action === 'listen' && state?.wake.status === 'detected' && playback.current) {
          const tone = playback.current.createOscillator(),
            gain = playback.current.createGain();
          tone.frequency.value = 880;
          gain.gain.value = 0.08;
          tone.connect(gain).connect(playback.current.destination);
          tone.start();
          tone.stop(playback.current.currentTime + 0.1);
          suppressUntil.current = Date.now() + 300;
        }
        recording.current = true;
        if (action !== 'arm-wake') conversationOwner.current = true;
        setState(value);
        await capture.current?.resume();
        if (automatic) {
          playback.current ??= new AudioContext();
          await playback.current.resume();
          ensureActive();
        }
      } else {
        if (action === 'stop-wake') wakeActive.current = false;
        if (
          (action === 'stop-listening' && !wakeActive.current) ||
          (action === 'disconnect' && !wakeActive.current) ||
          action === 'stop-wake'
        )
          stopMic();
        if (action === 'stop-speaking' || action === 'disconnect') resetPlayback();
        setState(await command(action, text ? { text } : {}));
      }
    } catch {
      if (operationEpoch.current !== epoch) return;
      stopMic();
      wakeActive.current = false;
      if (['listen', 'start-session', 'arm-wake'].includes(action))
        void command('pause-voice').catch(() => {});
      setError('操作未完成。请检查连接配置、麦克风权限和系统声音设置。');
    } finally {
      if (operationEpoch.current === epoch) {
        inOperation.current = false;
        pendingCapture.current = false;
        setOperating(false);
      }
    }
  }
  async function stopSession(explicit = true, notice = '') {
    if (explicit) explicitlyOff.current = true;
    operationEpoch.current++;
    stopMic();
    resetPlayback();
    wakeActive.current = conversationOwner.current = false;
    pendingWake.current = null;
    autoAttempted.current = autoRefresh;
    inOperation.current = pendingCapture.current = false;
    setOperating(false);
    try {
      setState(await command(explicit ? 'stop-session' : 'pause-voice'));
      if (notice) setError(notice);
    } catch {
      setError('本机麦克风已关闭，未能确认远端状态；请断开语音连接。');
    }
  }
  startCapture.current = (action) => operate(action);
  automaticWake.current = () => operate('arm-wake', undefined, true);
  interrupted.current = (message) => {
    if (recording.current) void stopSession(false, message);
  };
  async function setConnectionAuto(enabled: boolean) {
    try {
      setState(await command('connection-auto', { enabled }));
      setError('');
    } catch {
      setError('无法保存语音服务连接偏好，请检查本机配置。');
    }
  }
  async function setAutoWake(enabled: boolean) {
    explicitlyOff.current = !enabled;
    if (!enabled) {
      operationEpoch.current++;
      stopMic();
      resetPlayback();
      wakeActive.current = conversationOwner.current = false;
      pendingWake.current = null;
      inOperation.current = pendingCapture.current = false;
      setOperating(false);
    }
    autoAttempted.current = enabled ? null : autoRefresh;
    try {
      setState(await command('wake-auto', { enabled }));
      setAutoNotice('');
      setError('');
      setAutoRefresh((n) => n + 1);
    } catch {
      setError('未能保存自动唤醒偏好，请在设置中重试。');
    }
  }
  useEffect(() => {
    if (
      configuration ||
      explicitlyOff.current ||
      !state?.wakePreference.enabled ||
      state.wakeAutoSuspended ||
      !state.wake.installed ||
      ['armed', 'detected', 'loading', 'failed'].includes(state.wake.status) ||
      state.conversationActive ||
      recording.current ||
      autoAttempted.current === autoRefresh
    )
      return;
    autoAttempted.current = autoRefresh;
    let active = true;
    void window.lingxiDesktop
      ?.microphoneStatus?.()
      .then((permission) => {
        if (!active) return;
        if (permission !== 'granted') {
          setAutoNotice(
            permission === 'denied' || permission === 'restricted'
              ? '麦克风权限未获准，请到设置 → 语音唤醒与麦克风处理。'
              : '首次使用请在设置中允许麦克风；授权后会自动监听唤醒词。',
          );
          return;
        }
        setAutoNotice('');
        void automaticWake.current();
      })
      .catch(() => {
        if (active) setAutoNotice('无法读取麦克风授权状态，请在设置中检查。');
      });
    return () => {
      active = false;
    };
  }, [
    configuration,
    state?.wakePreference.enabled,
    state?.wakeAutoSuspended,
    state?.wake.installed,
    state?.wake.status,
    state?.conversationActive,
    autoRefresh,
  ]);
  useEffect(() => {
    const focus = () => {
      if (!recording.current) {
        autoAttempted.current = null;
        setAutoRefresh((n) => n + 1);
      }
    };
    const online = () => {
      if (latestVoice.current?.connectionPreference.enabled)
        void command('retry-connection')
          .then(setState)
          .catch(() => {});
    };
    window.addEventListener('focus', focus);
    window.addEventListener('online', online);
    let active = true;
    const timer = setInterval(() => {
      if (!recording.current) return;
      void window.lingxiDesktop
        ?.microphoneStatus?.()
        .then((permission) => {
          if (active && ['denied', 'restricted'].includes(permission))
            interrupted.current('麦克风权限已撤销，监听已停止。');
        })
        .catch(() => {});
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', online);
    };
  }, []);
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
      data-microphone-open={voiceMicrophoneOpen(state)}
      className={`voice-controls voice-${state?.status ?? 'disconnected'}${!configuration && presentation.submitted ? ' voice-submitted' : ''}`}
      aria-label="丽塔同学语音"
    >
      {variant !== 'wake' && (
        <>
          {configuration && (
            <div className="binding-wizard">
              <h3>绑定本机语音设备</h3>
              <p>1. 在七牛官方控制台登录并创建智能体。</p>
              <a
                className="setup-link"
                href="https://xrobo.qiniu.com/"
                target="_blank"
                rel="noreferrer"
              >
                打开七牛语音控制台 ↗
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
                  绑定已确认，连接配置已加密保存。现在可以连接丽塔同学并测试收音与播报。
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
              <summary className="voice-config-summary">高级：手动配置已绑定设备</summary>
              <p>
                在七牛语音控制台创建智能体并绑定本机设备，获取设备 WebSocket 令牌。此处使用官方 PCM
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
                允许主动收音后，通过丽塔同学 MCP 提交或停止 Codex 任务
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
          {configuration && state && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={state.connectionPreference.enabled}
                  onChange={(event) => void setConnectionAuto(event.target.checked)}
                />
                应用启动后自动连接并保持语音服务
              </label>
              {state.connectionPreference.source === 'legacy-review' && (
                <p>旧版未记录长期连接选择，请确认一次；不会新增绑定或凭据。</p>
              )}
              {state.connectionPreference.source === 'unavailable' && (
                <p role="alert">无法读取或保存连接偏好，自动连接已停用。</p>
              )}
            </>
          )}
          {configuration && state?.configured && (
            <>
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
              <p>
                默认关闭时仅保留转写草稿；开启并重新连接后，丽塔同学才可调用
                Codex。开启唤醒不会自动开启这项权限。
              </p>
            </>
          )}
          {configuration && (
            <>
              <VoiceHandoff state={state} showSettings={false} />
              <p>
                在七牛控制台打开绑定的智能体 →
                技能与扩展，选择「统一意图识别」，并确认聊天模型支持工具调用；保存后重新连接。「无意图识别」只做普通聊天。
              </p>
              <details>
                <summary>配置语音工作台角色</summary>
                <p>
                  工作台通过设备端 MCP
                  提供操作能力。可将下面的说明复制到云端智能体角色介绍，让页面修改要求交给 Codex。
                </p>
                <textarea
                  aria-label="语音工作台角色说明"
                  value={LINGXI_WORKBENCH_ROLE}
                  readOnly
                  rows={5}
                />
                <button
                  className="button secondary"
                  type="button"
                  onClick={async () => {
                    try {
                      if (window.lingxiDesktop)
                        await window.lingxiDesktop.copy(LINGXI_WORKBENCH_ROLE);
                      else await navigator.clipboard.writeText(LINGXI_WORKBENCH_ROLE);
                      setRoleNotice('角色说明已复制，请在七牛语音控制台保存后重新连接。');
                    } catch {
                      setRoleNotice('未能复制，请选中上面的说明复制。');
                    }
                  }}
                >
                  复制角色说明
                </button>
                {roleNotice && <p role="status">{roleNotice}</p>}
                <a
                  href="https://linx.qiniu.com/docs/xrobot/guide/agent-config"
                  target="_blank"
                  rel="noreferrer"
                >
                  官方智能体配置说明 ↗
                </a>
              </details>
            </>
          )}
          <p role="status" className="voice-status">
            <MicrophoneIcon muted={!voiceMicrophoneOpen(state)} />
            <span>
              {!configuration && autoNotice && !recording.current
                ? '自动唤醒待授权 · 麦克风已关闭'
                : configuration &&
                    state &&
                    !state.conversationActive &&
                    !['armed', 'detected'].includes(state.wake.status)
                  ? labels[state.status]
                  : presentation.label}
            </span>
            <small
              role="status"
              className="voice-service-state"
              data-connected={voiceServiceConnected(state)}
              aria-label="语音服务连接状态"
              title={
                state?.connection.nextRetryAt
                  ? `下次重连：${new Date(state.connection.nextRetryAt).toLocaleTimeString()}`
                  : undefined
              }
            >
              {voiceConnectionLabel(state)}
            </small>
          </p>
          <div className="live-actions">
            {(configuration ||
              (state?.configured && ['disconnected', 'failed'].includes(state.status))) && (
              <button
                type="button"
                disabled={!state?.configured || !['disconnected', 'failed'].includes(state.status)}
                onClick={() => void operate('connect')}
              >
                连接丽塔同学
              </button>
            )}
            {!configuration && state && !state.configured && (
              <SettingsLink section="lingxi" label="连接设置" />
            )}
            {!configuration &&
              state?.wakePreference.enabled &&
              !recording.current &&
              (autoNotice || !state.wake.installed) && (
                <SettingsLink section="wake" label="配置默认唤醒" />
              )}
            {state && !state.conversationActive && state.status === 'ready' && (
              <button
                type="button"
                disabled={operating || !!listenUnavailable}
                title={listenUnavailable}
                onClick={() => void operate('start-session')}
              >
                开始收音
              </button>
            )}
            {(state?.conversationActive || (operating && pendingCapture.current)) && (
              <button type="button" onClick={() => void stopSession()}>
                关闭语音
              </button>
            )}
            {configuration && state && !['disconnected', 'failed'].includes(state.status) && (
              <button type="button" onClick={() => void operate('disconnect')}>
                断开语音服务
              </button>
            )}
            {!configuration && state && !['disconnected', 'failed'].includes(state.status) && (
              <details className="voice-more">
                <summary aria-label="更多语音操作" title="更多语音操作">
                  ⋯
                </summary>
                <div>
                  <button type="button" onClick={() => void operate('disconnect')}>
                    断开语音服务
                  </button>
                </div>
              </details>
            )}
            {configuration && (
              <button
                type="button"
                disabled={!state || !['ready', 'speaking'].includes(state.status)}
                onClick={() => void operate('speak', '丽塔同学已连接，现在可以开始共创。')}
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
          {configuration && state && (
            <label>
              <input
                type="checkbox"
                checked={state.wakePreference.enabled}
                onChange={(event) => void setAutoWake(event.target.checked)}
              />
              自动开启本地语音唤醒
            </label>
          )}
          {state?.wakePreference.source === 'legacy-review' && (
            <p>旧版未记录长期唤醒选择。请确认一次是否自动唤醒；之后会记住选择。</p>
          )}
          {state?.wakePreference.source === 'unavailable' && (
            <p role="alert">无法读取或保存唤醒偏好，自动监听已暂停，请在设置中检查。</p>
          )}
          {autoNotice && (
            <p role="status">
              {autoNotice} <SettingsLink section="wake" label="检查麦克风设置" />
            </p>
          )}
          {!configuration && state?.wakePreference.enabled && !state.wake.installed && (
            <p>默认唤醒正在等待本地模型，请先完成配置。</p>
          )}

          {configuration ? <h3>本地唤醒模型</h3> : <summary>语音唤醒</summary>}
          {configuration && (
            <p>下载一次后离线检测，无需额外账号。在这里设置本次唤醒词，完成后回工作台开启检测。</p>
          )}
          {!configuration && (
            <>
              <p>
                默认在本机监听“丽塔同学”，唤醒后才处理语音；待唤醒音频不上传、不保存。关闭会记住选择，不会自动重新开启。
              </p>
              <p>
                唤醒词：{state?.wake.keyword ?? keyword}{' '}
                <SettingsLink section="wake" label="修改唤醒词" />
              </p>
            </>
          )}
          {!state?.wake.installed &&
            (configuration ? (
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
            ) : (
              <SettingsLink section="wake" label="配置语音唤醒" />
            ))}
          {configuration && (
            <>
              <label>
                本次运行的唤醒词
                <input
                  value={keyword}
                  maxLength={12}
                  disabled={operating}
                  onChange={(event) => {
                    keywordEdited.current = true;
                    setKeyword(event.target.value);
                  }}
                />
              </label>
              <button
                className="button secondary"
                type="button"
                disabled={operating || !/^[\u4e00-\u9fff]{2,12}$/.test(keyword)}
                onClick={async () => {
                  try {
                    setState(await command('wake-keyword', { keyword }));
                    keywordEdited.current = false;
                    setError('');
                  } catch {
                    setError('未能修改唤醒词，请先关闭正在运行的语音唤醒后重试。');
                  }
                }}
              >
                保存本次唤醒词
              </button>
              <p>此项只在本次应用运行期间保留，重启后恢复“丽塔同学”。保存不会开启麦克风。</p>
            </>
          )}
          {state?.wake.installed && configuration && (
            <p role="status">模型文件已下载。已有麦克风授权时，回到工作台自动监听唤醒词。</p>
          )}
          {!configuration &&
            state &&
            (!state.wakePreference.enabled || state.wakeAutoSuspended) && (
              <button type="button" onClick={() => void setAutoWake(true)}>
                {state.wakePreference.enabled ? '恢复自动唤醒' : '启用自动唤醒'}
              </button>
            )}
          {state && ['armed', 'detected', 'loading'].includes(state.wake.status) && (
            <button type="button" onClick={() => void setAutoWake(false)}>
              关闭语音唤醒
            </button>
          )}
          <details>
            <summary>音频来源与回声</summary>
            <p>
              只请求系统默认音频输入，不采集屏幕或系统输出；如果默认输入是虚拟回环设备，也可能收到电脑播放的声音。
            </p>
            <p>当前输入：{recording.current && audioInput ? audioInput.label : '麦克风未开启'}</p>
            {recording.current && audioInput && (
              <p>
                浏览器报告：
                {(['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const)
                  .map(
                    (key, i) =>
                      `${['回声消除', '降噪', '自动增益'][i]} ${audioInput[key] === undefined ? '未报告' : audioInput[key] ? '开启' : '关闭'}`,
                  )
                  .join(' · ')}
              </p>
            )}
            <p>
              回声消除不能保证过滤所有外放。若误触发，请使用耳机，并在 macOS
              声音设置核对物理麦克风与虚拟输入。
            </p>
          </details>
          {state?.wake.error && <p role="alert">{state.wake.error}</p>}
        </WakePanel>
      )}
      {configuration && variant !== 'wake' && <VoiceDiagnostics />}
      {state?.subtitle && <p>{state.subtitle}</p>}
      {configuration && state?.draft && <p>转写草稿：{state.draft}</p>}
      {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
    </section>
  );
}
