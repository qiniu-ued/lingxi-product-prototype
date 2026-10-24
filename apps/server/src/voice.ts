import { randomUUID } from 'node:crypto';
import {
  LINGXI_WORKBENCH_ROLE,
  type VoiceCommand,
  type VoiceConfig,
  type VoiceState,
  voiceConfigSchema,
} from '@lingxi/protocol';
import WebSocket from 'ws';
import { z } from 'zod';
import type { DesktopBridge } from './desktop-bridge.js';
import type { WakeModel } from './wake-model.js';
import type { WakePreferences } from './wake-preferences.js';
import type { Workbench } from './workbench.js';

const envelope = z.object({ type: z.string(), session_id: z.string().optional() }).passthrough();
const rpc = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});
const textInput = z.strictObject({ text: z.string().trim().min(1).max(4000) });
const modeInput = z.strictObject({ mode: z.enum(['plan', 'default']) });
const toolErrors: Record<string, string> = {
  voice_submit_disabled:
    '本机尚未开启语音执行。请在设置 → 丽塔同学与语音执行勾选允许语音提交，保存后重新连接丽塔同学；本轮未交给 Codex。',
  capture_required: '没有有效的主动收音，请在工作台开始收音后重试。',
  capture_expired: '本次收音的操作窗口已结束，请重新收音；不会自动重放旧指令。',
  voice_context_changed: '项目或对话已切换，请在当前工作台重新收音。',
  project_required: '尚未选择项目，请在工作区新建或打开项目后重新收音。',
  task_running: 'Codex 当前仍在执行，本轮没有新建任务。请等待当前任务结束后重试。',
  selection_stale: '页面或点选目标已变化，请重新点选并收音。',
  capture_already_submitted: '这次收音已经提交过任务，请重新收音以提出新的要求。',
};

// Lingxi is the MCP client; this Mac is its device MCP server, encapsulated in
// the outbound WSS. It is separate from Codex's authenticated preview MCP.
export class VoiceService {
  private socket: WebSocket | undefined;
  private connectionLoop = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private connectionEpoch = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private retryAttempt = 0;
  private lastPong = 0;
  private connectedAt = 0;
  private lastNetworkRetry = 0;

  private sessionId = '';
  private config: VoiceConfig | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private captureDeadline: ReturnType<typeof setTimeout> | undefined;
  private armedUntil = 0;
  private unsubscribe: () => void;
  private lastAnnouncement = '';
  private previousTask: { id: string; status: string } | null = null;
  private pendingSpeech = '';
  private awaitingSpeech = false;
  private speechDeadline: ReturnType<typeof setTimeout> | undefined;
  private capturedContext: ReturnType<Workbench['voiceContext']> = {
    selection: null,
    attachments: [],
  };
  private target = '';
  private submittedCapture: string | null = null;
  private modeInCapture: 'plan' | 'default' | null = null;
  private modePending = false;
  private wakeEnabled = false;
  private automaticCapture = false;
  private wakeLease: ReturnType<typeof setInterval> | undefined;
  private lastFrame = 0;
  private captureFrames = 0;
  private voicedFrames = 0;
  private silentFrames = 0;
  private speechFrames = 0;
  private speechBlocked = false;
  private captureEpoch = 0;
  private speechBuffer: Buffer[] = [];
  private responses = new Map<string, { input: string; value: unknown }>();
  private state: VoiceState = {
    configured: false,
    status: 'disconnected',
    conversationActive: false,
    speechId: null,
    draft: '',
    captureId: null,
    subtitle: '',
    error: null,
    allowVoiceSubmit: false,
    deviceToolsReady: false,
    handoff: null,
    contextDetailsOpen: false,
    wakePreference: { version: 1, enabled: false, source: 'legacy-review' },
    wakeAutoSuspended: false,
    connectionPreference: { version: 1, enabled: false, source: 'legacy-review' },
    connection: { attempt: 0, nextRetryAt: null, exhausted: false },
    wake: { status: 'off', keyword: '丽塔同学', installed: false, detectionId: null, error: null },
  };
  constructor(
    private options: {
      desktop?: DesktopBridge;
      workbench: Pick<
        Workbench,
        'read' | 'start' | 'interrupt' | 'decide' | 'subscribe' | 'voiceContext' | 'command'
      >;
      testEndpoint?: string;
      wakePreferences?: Pick<WakePreferences, 'read' | 'save'>;
      connectionPreferences?: Pick<WakePreferences, 'read' | 'save'>;
      wake?: Pick<WakeModel, 'installed' | 'install' | 'start' | 'frame' | 'reset' | 'stop'> & {
        close: () => void | Promise<void>;
      };
    },
  ) {
    this.state.wakePreference = options.wakePreferences?.read() ?? this.state.wakePreference;
    this.state.connectionPreference =
      options.connectionPreferences?.read() ?? this.state.connectionPreference;
    this.unsubscribe = options.workbench.subscribe(() => this.observeTask());
  }
  private observeTask() {
    const task = this.options.workbench.read().task;
    const previous = this.previousTask;
    this.previousTask = task ? { id: task.id, status: task.status } : null;
    if (!this.socket || (!this.state.conversationActive && !this.wakeEnabled)) return;
    if (
      task &&
      task.status !== 'waiting' &&
      (previous?.id !== task.id || ['completed', 'failed', 'interrupted'].includes(previous.status))
    )
      return;
    if (!task || !['waiting', 'completed', 'failed', 'interrupted'].includes(task.status)) return;
    const key = `${task.id}:${task.status}:${task.approval?.id ?? ''}`;
    if (key === this.lastAnnouncement) return;
    this.lastAnnouncement = key;
    if (task.status === 'waiting') {
      const question = task.approval?.questions?.find((q) => !q.isSecret);
      this.pendingSpeech = question
        ? `Codex 需要你回答：${question.question.slice(0, 180)}`
        : task.approval?.kind === 'question'
          ? 'Codex 需要在操作台补充信息。请用键盘输入敏感内容。'
          : 'Codex 需要操作台确认。请在电脑上查看权限请求。';
    } else
      this.pendingSpeech =
        task.status === 'completed'
          ? 'Codex 本轮已结束。请查看操作台的回复与实际成果。'
          : task.status === 'interrupted'
            ? 'Codex 任务已停止，文件修改保留。'
            : 'Codex 本轮未完成，请在操作台检查连接和项目。';
    this.flushSpeech();
  }
  private flushSpeech() {
    if (!this.pendingSpeech || this.state.status !== 'ready' || this.awaitingSpeech) return;
    const text = this.pendingSpeech;
    this.pendingSpeech = '';
    this.awaitingSpeech = true;
    this.send({ type: 'listen', state: 'detect', text: '工作台状态播报', text_response: text });
    this.speechDeadline = setTimeout(() => {
      this.awaitingSpeech = false;
      this.flushSpeech();
    }, 15000);
  }
  read() {
    if (this.state.handoff?.status === 'awaiting-tool' && this.state.draft) {
      if (this.target !== this.context())
        return {
          ...this.state,
          handoff: {
            ...this.state.handoff,
            status: 'blocked' as const,
            message: toolErrors.voice_context_changed as string,
          },
        };
      if (Date.now() > this.armedUntil)
        return {
          ...this.state,
          handoff: {
            ...this.state.handoff,
            status: 'unhandled' as const,
            message: '本轮语音没有交给 Codex，收音操作窗口已结束。可使用转写草稿提交，或重新收音。',
          },
        };
    }
    return this.state;
  }
  private handoff(
    status: NonNullable<VoiceState['handoff']>['status'],
    message: string,
    taskId: string | null = null,
    captureId = this.state.captureId,
  ) {
    if (
      captureId !== this.state.captureId ||
      (this.state.handoff?.captureId === captureId &&
        this.state.handoff.status === 'submitted' &&
        status !== 'submitted')
    )
      return;
    this.update({ handoff: { captureId, status, message, taskId } });
  }
  private update(value: Partial<VoiceState>) {
    if (
      value.status === 'ready' &&
      this.state.status !== 'ready' &&
      this.state.status !== 'connecting' &&
      this.wakeEnabled
    ) {
      this.options.wake?.reset();
      value.wake = { ...this.state.wake, status: 'armed', detectionId: null };
    }
    this.state = { ...this.state, ...value };
  }
  private lease() {
    if (this.wakeLease) return;
    this.lastFrame = Date.now();
    this.wakeLease = setInterval(() => {
      if (Date.now() - this.lastFrame <= 4000) return;
      this.stopConversation('麦克风音频已中断，请手动重新开启语音。');
      this.stopWake('麦克风音频已中断，请重新开启唤醒。');
    }, 1000);
  }
  private stopConversation(error: string | null = null) {
    this.captureEpoch++;
    this.speechBlocked = true;
    this.pendingSpeech = '';
    this.awaitingSpeech = false;
    clearTimeout(this.speechDeadline);
    clearTimeout(this.captureDeadline);
    if (this.state.status === 'listening')
      this.send({ type: 'listen', state: 'stop', mode: 'manual' });
    if (['processing', 'speaking'].includes(this.state.status))
      this.send({ type: 'abort', reason: 'user_requested' });
    this.speechFrames = 0;
    this.speechBuffer = [];
    this.armedUntil = 0;
    this.update({
      conversationActive: false,
      speechId: null,
      error,
      ...(['listening', 'processing', 'speaking'].includes(this.state.status)
        ? { status: 'ready' as const }
        : {}),
    });
    if (!this.wakeEnabled) {
      clearInterval(this.wakeLease);
      this.wakeLease = undefined;
    }
  }
  private finishUtterance() {
    clearTimeout(this.captureDeadline);
    this.send({ type: 'listen', state: 'stop', mode: 'manual' });
    const hasSpeech = this.voicedFrames >= 10 || !!this.state.draft;
    this.armedUntil = hasSpeech ? Date.now() + 30000 : 0;
    this.speechBuffer = [];
    this.speechFrames = 0;
    this.update({ status: hasSpeech ? 'processing' : 'ready', speechId: null });
    if (hasSpeech) {
      const id = this.state.captureId;
      this.captureDeadline = setTimeout(() => {
        if (this.state.captureId !== id || this.state.status !== 'processing') return;
        this.armedUntil = 0;
        this.update({
          status: 'ready',
          error: '尚未收到语音回复，会话仍开启；可以再说一次或点击关闭语音。',
        });
      }, 30000);
    }
  }
  async save(input: unknown) {
    if (!this.options.desktop) throw new Error('desktop_required');
    const config = voiceConfigSchema.parse(input);
    await this.options.desktop.call('voice-config-save', config);
    const suspended = this.state.wakeAutoSuspended;
    this.disconnect();
    this.update({ wakeAutoSuspended: suspended });
    this.config = config;
    this.update({ configured: true, allowVoiceSubmit: config.allowVoiceSubmit });
    if (this.connectionLoop && this.state.connectionPreference.enabled)
      void this.startAutoConnection();
  }
  private context() {
    const state = this.options.workbench.read();
    return JSON.stringify([state.project?.id, state.selectedThreadId]);
  }
  async preferences(allowVoiceSubmit: boolean) {
    if (!this.config) await this.inspect();
    if (!this.config) throw new Error('voice_config_required');
    await this.save({ ...this.config, allowVoiceSubmit });
  }
  async inspect() {
    if (!this.options.desktop) return this.state;
    const config = await this.options.desktop.call('voice-config-read');
    this.config = config ? voiceConfigSchema.parse(config) : undefined;
    this.update({
      configured: !!this.config,
      allowVoiceSubmit: this.config?.allowVoiceSubmit ?? false,
      wake: { ...this.state.wake, installed: (await this.options.wake?.installed()) ?? false },
    });
    return this.state;
  }
  private setWakePreference(enabled: boolean) {
    try {
      const preference = this.options.wakePreferences?.save(enabled) ?? {
        version: 1 as const,
        enabled,
        source: 'user' as const,
      };
      this.update({ wakePreference: preference, wakeAutoSuspended: !enabled });
      if (enabled && !this.wakeEnabled)
        this.update({ wake: { ...this.state.wake, status: 'off', error: null } });
    } catch {
      this.update({
        wakePreference: { version: 1, enabled: false, source: 'unavailable' },
        wakeAutoSuspended: true,
      });
      throw new Error('wake_preference_unavailable');
    }
  }
  async command(command: VoiceCommand) {
    if (this.closed) throw new Error('voice_closed');
    if (!this.options.desktop) throw new Error('desktop_required');
    if (command.action === 'stop-session') {
      this.stopWake();
      this.stopConversation();
      this.update({ wakeAutoSuspended: true });
      try {
        this.setWakePreference(false);
      } finally {
        try {
          this.setConnectionPreference(false);
        } finally {
          this.disconnect();
          await this.options.desktop.call('voice-audio', { reset: true });
        }
      }
      return;
    }
    if (command.action === 'pause-voice') {
      const suspended = this.state.wakeAutoSuspended;
      this.stopWake();
      this.stopConversation();
      this.update({ wakeAutoSuspended: suspended || (command.suspend ?? true) });
      await this.options.desktop.call('voice-audio', { reset: true });
      return;
    }
    if (command.action === 'connection-auto') {
      this.setConnectionPreference(command.enabled);
      if (command.enabled) await this.startAutoConnection();
      else this.disconnectTransport();
      return;
    }
    if (command.action === 'retry-connection') {
      if (this.state.connectionPreference.enabled && Date.now() - this.lastNetworkRetry >= 5000) {
        this.lastNetworkRetry = Date.now();
        await this.startAutoConnection(true);
      }
      return;
    }
    if (command.action === 'wake-auto') {
      if (!command.enabled) {
        this.stopWake();
        this.stopConversation();
      }
      this.setWakePreference(command.enabled);
      return;
    }
    if (command.action === 'dismiss-wake') {
      if (this.wakeEnabled && !this.state.conversationActive) {
        this.options.wake?.reset();
        this.update({ wake: { ...this.state.wake, status: 'armed', detectionId: null } });
      }
      return;
    }
    if (command.action === 'context-details') {
      this.update({ contextDetailsOpen: command.open });
      return;
    }
    if (command.action === 'wake-keyword') {
      if (this.wakeEnabled || this.state.wake.status === 'loading') throw new Error('wake_active');
      this.update({ wake: { ...this.state.wake, keyword: command.keyword } });
      return;
    }
    if (command.action === 'stop-wake') {
      this.stopWake();
      this.stopConversation();
      this.update({ wakeAutoSuspended: true });
      this.setWakePreference(false);
      return;
    }
    if (command.action === 'install-wake') {
      if (
        !this.options.wake ||
        ['installing', 'loading', 'armed', 'detected'].includes(this.state.wake.status)
      )
        throw new Error('wake_unavailable');
      this.update({ wake: { ...this.state.wake, status: 'installing', error: null } });
      try {
        await this.options.wake.install();
        this.update({ wake: { ...this.state.wake, status: 'off', installed: true } });
      } catch {
        this.update({
          wake: {
            ...this.state.wake,
            status: 'failed',
            error: '唤醒模型下载失败，请检查网络后重试。',
          },
        });
      }
      return;
    }
    if (command.action === 'connect') {
      this.setConnectionPreference(true);
      this.connectionLoop = true;
      await this.connect();
      return;
    }
    if (command.action === 'disconnect') {
      this.setConnectionPreference(false);
      this.disconnectTransport();
      return;
    }
    if (command.action === 'arm-wake') {
      const epoch = ++this.captureEpoch;
      if (
        command.automatic &&
        (!this.state.wakePreference.enabled ||
          this.state.wakeAutoSuspended ||
          (await this.options.desktop.call('microphone-status')) !== 'granted')
      )
        throw new Error('wake_auto_not_ready');
      if (epoch !== this.captureEpoch) throw new Error('wake_cancelled');
      if (
        !this.options.wake ||
        !['ready', 'connecting', 'disconnected', 'failed'].includes(this.state.status) ||
        this.wakeEnabled ||
        this.state.wake.status === 'loading'
      )
        throw new Error('wake_unavailable');
      this.update({
        wake: { ...this.state.wake, status: 'loading', keyword: command.keyword, error: null },
      });
      try {
        await this.options.wake.start(
          command.keyword,
          () => {
            if (
              this.wakeEnabled &&
              ['ready', 'connecting', 'disconnected', 'failed'].includes(this.state.status) &&
              this.state.wake.status === 'armed'
            )
              this.update({
                wake: { ...this.state.wake, status: 'detected', detectionId: randomUUID() },
              });
          },
          () => this.stopWake('本地唤醒检测已停止，请重新开启。'),
        );
        if (
          epoch !== this.captureEpoch ||
          !['ready', 'connecting', 'disconnected', 'failed'].includes(this.state.status) ||
          this.read().wake.status !== 'loading'
        )
          throw new Error('wake_cancelled');
        this.wakeEnabled = true;
        this.lastFrame = Date.now();
        this.update({ wake: { ...this.state.wake, status: 'armed' } });
        this.lease();
      } catch {
        this.stopWake('无法启动本地唤醒，请确认模型已下载并尝试其他中文唤醒词。');
      }
      return;
    }
    if (
      !this.socket ||
      !['ready', 'listening', 'processing', 'speaking'].includes(this.state.status)
    )
      throw new Error('voice_not_ready');
    if (command.action === 'start-session') {
      this.captureEpoch++;
      if (this.state.status !== 'ready') throw new Error('voice_not_ready');
      this.update({ conversationActive: true, speechId: null, error: null });
      this.speechBlocked = false;
      this.speechBuffer = [];
      this.speechFrames = 0;
      this.lease();
      return;
    }
    if (command.action === 'listen') {
      const epoch = ++this.captureEpoch;
      this.speechBlocked = false;
      const context = this.options.workbench.voiceContext(),
        target = this.context();
      this.pendingSpeech = '';
      this.awaitingSpeech = false;
      clearTimeout(this.speechDeadline);
      this.send({ type: 'abort', reason: 'wake_word_detected' });
      await this.options.desktop.call('voice-audio', { reset: true });
      if (epoch !== this.captureEpoch) throw new Error('voice_capture_cancelled');
      if (target !== this.context()) throw new Error('voice_context_changed');
      this.update({
        status: 'listening',
        conversationActive: true,
        speechId: null,
        captureId: randomUUID(),
        draft: '',
        subtitle: '',
        error: null,
      });
      this.target = target;
      this.handoff(
        this.config?.allowVoiceSubmit ? 'awaiting-tool' : 'draft-only',
        this.config?.allowVoiceSubmit
          ? '本轮尚未交给 Codex，等待丽塔同学调用工作台工具。'
          : '当前仅转写草稿，未开启语音执行；不会自动交给 Codex。',
      );
      this.automaticCapture = this.wakeEnabled && this.state.wake.status === 'detected';
      this.captureFrames = this.voicedFrames = this.silentFrames = 0;
      this.capturedContext = context;
      this.armedUntil = Date.now() + 90_000;
      this.submittedCapture = null;
      this.modeInCapture = null;
      this.send({ type: 'listen', state: 'start', mode: 'manual' });
      this.lease();
      const buffered = this.speechBuffer;
      this.speechBuffer = [];
      this.speechFrames = 0;
      clearTimeout(this.captureDeadline);
      this.captureDeadline = setTimeout(() => {
        if (this.state.status === 'listening') this.finishUtterance();
      }, 60000);
      for (const frame of buffered) this.frame(frame.toString('base64'));
    } else if (command.action === 'stop-listening') {
      if (this.state.status !== 'listening') throw new Error('voice_not_listening');
      clearTimeout(this.captureDeadline);
      this.captureDeadline = undefined;
      this.send({ type: 'listen', state: 'stop', mode: 'manual' });
      this.armedUntil = this.automaticCapture && this.voicedFrames < 10 ? 0 : Date.now() + 30000;
      this.update({ status: 'ready' });
      this.flushSpeech();
    } else if (command.action === 'stop-speaking') {
      this.speechBlocked = true;
      this.pendingSpeech = '';
      this.awaitingSpeech = false;
      clearTimeout(this.speechDeadline);
      this.send({ type: 'abort', reason: 'user_requested' });
      await this.options.desktop.call('voice-audio', { reset: true });
      this.update({ status: 'ready', subtitle: '' });
    } else {
      this.speechBlocked = false;
      this.send({
        type: 'listen',
        state: 'detect',
        text: '工作台状态播报',
        text_response: command.text,
      });
    }
  }
  private setConnectionPreference(enabled: boolean) {
    // Stop retry scheduling before persisting a user's off intent.
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAttempt = 0;
    try {
      const preference = this.options.connectionPreferences?.save(enabled) ?? {
        version: 1 as const,
        enabled,
        source: 'user' as const,
      };
      this.update({
        connectionPreference: preference,
        connection: { attempt: 0, nextRetryAt: null, exhausted: false },
      });
    } catch {
      this.update({ connectionPreference: { version: 1, enabled: false, source: 'unavailable' } });
      this.disconnectTransport();
      throw new Error('connection_preference_unavailable');
    }
  }
  async startAutoConnection(reset = false) {
    if (this.closed) return;
    if (reset) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.retryAttempt = 0;
      this.update({ connection: { attempt: 0, nextRetryAt: null, exhausted: false } });
    }
    this.connectionLoop = true;
    if (!this.state.connectionPreference.enabled || this.socket || this.retryTimer) return;
    const epoch = this.connectionEpoch;
    try {
      if (!this.config) await this.inspect();
      if (
        epoch !== this.connectionEpoch ||
        !this.state.connectionPreference.enabled ||
        !this.connectionLoop ||
        this.socket ||
        !this.config
      )
        return;
      await this.connect();
    } catch {
      if (epoch === this.connectionEpoch) this.fail('无法读取语音连接配置，请检查本机绑定。');
    }
  }
  private retryConnection() {
    if (!this.connectionLoop || !this.state.connectionPreference.enabled || this.retryTimer) return;
    const delays = [1000, 2000, 4000, 8000, 16000, 30000];
    const delay = delays[this.retryAttempt];
    if (delay === undefined) {
      this.update({
        connection: { attempt: this.retryAttempt, nextRetryAt: null, exhausted: true },
      });
      return;
    }
    this.retryAttempt++;
    this.update({
      connection: {
        attempt: this.retryAttempt,
        nextRetryAt: new Date(Date.now() + delay).toISOString(),
        exhausted: false,
      },
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.startAutoConnection();
    }, delay);
  }
  private async connect() {
    const epoch = this.connectionEpoch;
    if (this.socket) throw new Error('voice_already_connected');
    if (!this.config) await this.inspect();
    if (epoch !== this.connectionEpoch) return;
    if (!this.config) throw new Error('voice_config_required');
    const config = this.config;
    this.update({ status: 'connecting', error: null });
    const socket = new WebSocket(this.options.testEndpoint ?? config.endpoint, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Protocol-Version': '1',
        'Device-Id': config.deviceId,
        'Client-Id': config.clientId,
      },
      handshakeTimeout: 10000,
      maxPayload: 256 * 1024,
      followRedirects: false,
    });
    this.socket = socket;
    this.deadline = setTimeout(
      () => this.fail('语音握手超时，请检查设备绑定与网络。', true),
      10000,
    );
    socket.on('open', () =>
      this.send({
        type: 'hello',
        version: 1,
        transport: 'websocket',
        features: { mcp: true },
        audio_params: {
          format: 'pcm',
          sample_rate: 16000,
          channels: 1,
          bit_depth: 16,
          endianness: 'little',
          frame_duration: 20,
          frame_size: 320,
          sample_format: 'signed_int16',
          play_buffer_duration: 1000,
        },
      }),
    );
    socket.on('message', (data, binary) => {
      if (this.socket !== socket) return;
      if (binary) {
        if (this.state.status === 'speaking' && data instanceof Buffer && data.length % 2 === 0) {
          void this.options.desktop
            ?.call('voice-audio', { pcm: data.toString('base64'), sampleRate: 16000 })
            .catch(() => this.fail('无法播放语音，请重新连接。'));
        }
        return;
      }
      try {
        this.receive(JSON.parse(data.toString()));
      } catch {
        this.fail('丽塔同学返回了不兼容的消息，请检查服务配置。');
      }
    });
    socket.on('unexpected-response', (_request, response) => {
      if (this.socket !== socket) return;
      const denied = response.statusCode === 401 || response.statusCode === 403;
      response.destroy();
      this.fail(
        denied ? '语音设备认证未通过，请在设置检查绑定；已暂停自动重连。' : '语音网关暂不可用。',
        !denied,
      );
    });
    socket.on('pong', () => {
      if (this.socket === socket) this.lastPong = Date.now();
    });
    socket.on('error', () => {
      if (this.socket === socket) this.fail('无法连接丽塔同学，请核对设备绑定与网络。', true);
    });
    socket.on('close', () => {
      if (this.socket === socket) this.fail('丽塔同学连接已断开。', true);
    });
  }
  frame(base64: string) {
    if (base64.length > 900) return;
    const pcm = Buffer.from(base64, 'base64');
    if (pcm.length !== 640) return;
    if (this.wakeEnabled || this.state.conversationActive) this.lastFrame = Date.now();
    if (this.state.status !== 'listening') {
      if (this.state.conversationActive && this.state.status === 'ready') {
        let energy = 0;
        for (let i = 0; i < pcm.length; i += 2) energy += (pcm.readInt16LE(i) / 32768) ** 2;
        const voiced = Math.sqrt(energy / 320) > 0.015;
        this.speechBuffer.push(pcm);
        if (!this.state.speechId && this.speechBuffer.length > 15) this.speechBuffer.shift();
        this.speechFrames = voiced ? this.speechFrames + 1 : 0;
        if (!this.state.speechId && this.speechFrames >= 5) this.update({ speechId: randomUUID() });
        if (this.speechBuffer.length > 100) {
          this.stopConversation('未能开始本轮收音，请点击开始语音重试。');
          this.stopWake('未能开始本轮收音，请手动重新开启。');
        }
      } else if (
        this.wakeEnabled &&
        ['ready', 'connecting', 'disconnected', 'failed'].includes(this.state.status) &&
        this.state.wake.status === 'armed'
      )
        this.options.wake?.frame(pcm);
      return;
    }
    if (!this.socket || this.socket.bufferedAmount > 64000) return;
    this.socket.send(pcm);
    if (this.state.conversationActive || this.automaticCapture) {
      this.captureFrames++;
      let energy = 0;
      for (let i = 0; i < pcm.length; i += 2) energy += (pcm.readInt16LE(i) / 32768) ** 2;
      if (Math.sqrt(energy / 320) > 0.015) {
        this.voicedFrames++;
        this.silentFrames = 0;
      } else this.silentFrames++;
      if (
        (this.voicedFrames >= 10 && this.silentFrames >= 60 && this.captureFrames >= 100) ||
        (this.voicedFrames < 10 && this.captureFrames >= 400)
      )
        this.finishUtterance();
    }
  }
  private send(value: Record<string, unknown>, sent?: () => void) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(
        JSON.stringify({ ...(this.sessionId ? { session_id: this.sessionId } : {}), ...value }),
        sent,
      );
  }
  private receive(input: unknown) {
    const message = envelope.parse(input);
    if (message.session_id && this.sessionId && message.session_id !== this.sessionId) return;
    if (message.type === 'hello') {
      if (this.state.status !== 'connecting') return;
      const audio = z
        .object({ format: z.literal('pcm'), sample_rate: z.literal(16000), channels: z.literal(1) })
        .safeParse(message.audio_params);
      if (!audio.success) {
        this.fail(
          '服务未协商 PCM 16kHz 单声道，请在丽塔同学配置 PCM；本版不把 Opus 音频当 PCM 播放。',
        );
        return;
      }
      clearTimeout(this.deadline);
      this.deadline = undefined;
      this.sessionId = message.session_id ?? '';
      this.connectedAt = this.lastPong = Date.now();
      this.update({
        status: 'ready',
        error: null,
        connection: { attempt: this.retryAttempt, nextRetryAt: null, exhausted: false },
      });
      this.heartbeat = setInterval(() => {
        if (this.socket?.readyState !== WebSocket.OPEN) return;
        if (Date.now() - this.lastPong > 45000) {
          this.fail('语音服务保活响应超时。', true);
          return;
        }
        if (Date.now() - this.connectedAt >= 30000) this.retryAttempt = 0;
        this.socket.ping();
      }, 20000);
    } else if (message.type === 'stt') {
      if (!this.state.captureId || Date.now() > this.armedUntil) return;
      if (this.target !== this.context()) {
        this.handoff('blocked', toolErrors.voice_context_changed as string);
        return;
      }
      const text = z.string().max(4000).parse(message.text);
      this.update({ draft: text }); // STT alone never executes a task.
    } else if (message.type === 'tts') {
      if (this.speechBlocked) return;
      const event = z
        .object({
          state: z.enum(['start', 'stop', 'sentence_start']),
          text: z.string().max(4000).optional(),
          is_aborted: z.boolean().optional(),
        })
        .parse(message);
      if (
        event.state === 'start' &&
        (this.state.status !== 'listening' || this.state.conversationActive)
      ) {
        clearTimeout(this.captureDeadline);
        clearTimeout(this.speechDeadline);
        this.awaitingSpeech = false;
        this.update({ status: 'speaking' });
      }
      if (event.state === 'sentence_start') this.update({ subtitle: event.text ?? '' });
      if (event.state === 'stop') {
        if (this.state.draft && this.state.handoff?.status === 'awaiting-tool')
          this.handoff(
            'unhandled',
            this.state.deviceToolsReady
              ? '丽塔同学本轮没有提交给 Codex。请检查云端智能体的工具调用配置，或使用转写草稿提交。'
              : '丽塔同学尚未读取工作台工具列表，本轮没有提交给 Codex。请检查云端意图识别配置并重新连接。',
          );
        if (event.is_aborted)
          void this.options.desktop?.call('voice-audio', { reset: true }).catch(() => {});
        if (this.state.status === 'speaking') {
          this.update({ status: 'ready' });
          this.speechFrames = 0;
          this.speechBuffer = [];
          this.flushSpeech();
        }
      }
    } else if (message.type === 'mcp') {
      const request = rpc.safeParse(message.payload);
      if (request.success) void this.mcp(request.data);
    }
  }
  private async mcp(request: z.infer<typeof rpc>) {
    const key = JSON.stringify(request.id),
      serialized = JSON.stringify(request);
    const prior = this.responses.get(key);
    if (prior) {
      if (prior.input === serialized) this.send({ type: 'mcp', payload: prior.value });
      return;
    }
    let result: unknown;
    let closeAfterReply = false;
    if (request.method === 'initialize')
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'lingxi-workbench-device', version: '0.2.0' },
        instructions: LINGXI_WORKBENCH_ROLE,
      };
    else if (request.method === 'tools/list') {
      this.update({ deviceToolsReady: true });
      result = {
        tools: [
          {
            name: 'workbench_voice_close',
            description:
              '用户明确说关闭语音、停止收音或结束语音会话时调用。仅关闭麦克风会话与唤醒，不停止 Codex 任务，不更改任何执行权限。',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
          {
            name: 'workbench_status',
            description: '读取当前项目、任务进度和待回答问题。',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
          {
            name: 'workbench_submit',
            description:
              '把用户的页面或代码修改要求交给本机 Codex 执行，例如“把这个页面变成粉色”“修改布局”“把标题改成周末出发”。无需用户额外说提交任务，也不要以语音助手不能编辑文件为由拒绝转交。受本机语音授权、当前项目和收音窗口限制，一次收音最多一个任务；返回 taskId 仅表示任务已接收。',
            inputSchema: z.toJSONSchema(textInput),
          },
          {
            name: 'workbench_set_mode',
            description:
              '用户明确说切换到计划模式或执行模式时调用，只影响新提交任务。仅在主动收音并允许语音控制时可用。不修改权限，不提交开发任务。',
            inputSchema: z.toJSONSchema(modeInput),
          },
          {
            name: 'workbench_context_details',
            description:
              '用户要求打开或关闭上下文窗口用量详情时调用，同时作用于电脑和大屏。不提交开发任务。',
            inputSchema: {
              type: 'object',
              properties: { open: { type: 'boolean' } },
              required: ['open'],
              additionalProperties: false,
            },
          },
          {
            name: 'workbench_interrupt',
            description: '用户明确要求停止当前 Codex 任务时调用。不会回退代码。',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ].map((tool) => ({ ...tool, type: 0 })),
        nextCursor: null,
      };
    } else if (request.method === 'tools/call') {
      const captureId = this.state.captureId;
      try {
        const call = z
          .object({
            name: z.enum([
              'workbench_status',
              'workbench_voice_close',
              'workbench_submit',
              'workbench_interrupt',
              'workbench_set_mode',
              'workbench_context_details',
            ]),
            arguments: z.unknown(),
          })
          .parse(request.params);
        if (call.name === 'workbench_status') {
          z.strictObject({}).parse(call.arguments);
          const state = this.options.workbench.read();
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  project: state.project?.name,
                  taskId: state.task?.id,
                  status: state.task?.status,
                  activity: state.task?.activity,
                  voiceSubmitEnabled: this.config?.allowVoiceSubmit ?? false,
                  previewAvailable: !!state.preview,
                  conversationKind:
                    state.threads.find((thread) => thread.id === state.selectedThreadId)?.kind ??
                    null,
                  questions: state.task?.approvals
                    ?.filter((a) => a.kind === 'question')
                    .flatMap((a) => a.questions?.filter((q) => !q.isSecret) ?? []),
                }),
              },
            ],
          };
        } else if (call.name === 'workbench_voice_close') {
          z.strictObject({}).parse(call.arguments);
          if (
            !this.state.conversationActive ||
            !captureId ||
            Date.now() > this.armedUntil ||
            this.target !== this.context()
          )
            throw new Error('capture_required');
          this.stopWake();
          this.stopConversation();
          this.update({ wakeAutoSuspended: true });
          closeAfterReply = true;
          try {
            this.setWakePreference(false);
          } finally {
            try {
              this.setConnectionPreference(false);
            } finally {
              await this.options.desktop?.call('voice-audio', { reset: true });
            }
          }
          result = {
            content: [
              { type: 'text', text: '语音会话已关闭，麦克风与唤醒已停止。Codex 任务不受影响。' },
            ],
          };
        } else {
          if (!this.config?.allowVoiceSubmit) throw new Error('voice_submit_disabled');
          if (!this.state.captureId) throw new Error('capture_required');
          if (Date.now() > this.armedUntil) throw new Error('capture_expired');
          if (this.target !== this.context()) throw new Error('voice_context_changed');
          if (call.name === 'workbench_context_details') {
            const { open } = z.strictObject({ open: z.boolean() }).parse(call.arguments);
            this.update({ contextDetailsOpen: open });
            this.handoff(
              'handled',
              open
                ? '已展开上下文详情；没有创建开发任务。'
                : '已收起上下文详情；没有创建开发任务。',
            );
            result = {
              content: [
                { type: 'text', text: open ? '已展开上下文用量详情。' : '已收起上下文用量详情。' },
              ],
            };
          } else if (call.name === 'workbench_set_mode') {
            const { mode } = modeInput.parse(call.arguments);
            if (
              this.submittedCapture ||
              this.modePending ||
              (this.modeInCapture && this.modeInCapture !== mode)
            )
              throw new Error('capture_already_used');
            const captureId = this.state.captureId;
            this.modePending = true;
            try {
              await this.options.workbench.command(
                { action: 'set-mode', mode },
                () =>
                  this.state.captureId === captureId &&
                  this.target === this.context() &&
                  Date.now() <= this.armedUntil &&
                  !!this.config?.allowVoiceSubmit,
              );
              this.modeInCapture = mode;
              this.handoff(
                'handled',
                mode === 'plan'
                  ? '已切换到计划模式；没有创建开发任务。'
                  : '已切换到执行模式；没有创建开发任务。',
                null,
                captureId,
              );
            } finally {
              this.modePending = false;
            }
            const label = mode === 'plan' ? '计划模式' : '执行模式';
            this.pendingSpeech = `已切换到${label}，用于新提交的任务。`;
            this.flushSpeech();
            result = {
              content: [{ type: 'text', text: this.pendingSpeech || `已切换到${label}。` }],
            };
          } else if (call.name === 'workbench_submit') {
            if (this.modePending) throw new Error('mode_change_pending');
            const { text } = textInput.parse(call.arguments);
            if (this.submittedCapture && this.submittedCapture !== text)
              throw new Error('capture_already_submitted');
            const task = this.options.workbench.start(
              this.state.captureId,
              text,
              this.capturedContext.selection,
              this.capturedContext.attachments,
            );
            this.submittedCapture = text;
            this.target = this.context();
            this.handoff('submitted', '已交给 Codex，进度与回复在右侧对话中显示。', task.id);
            result = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    taskId: task.id,
                    status: task.status,
                    message: '已交给 Codex；请根据工作台真实状态播报进展，不能提前声称已完成。',
                  }),
                },
              ],
            };
          } else {
            z.strictObject({}).parse(call.arguments);
            this.options.workbench.interrupt();
            this.handoff('handled', '已请求停止当前 Codex 任务。');
            result = {
              content: [{ type: 'text', text: '已请求停止 Codex。已产生的文件修改保留。' }],
            };
          }
        }
      } catch (error) {
        const message = error instanceof Error ? toolErrors[error.message] : undefined;
        const detail =
          message ??
          '工作台未接受本次操作，请检查当前任务、项目和输入内容。开发请求未被接受时可以使用转写草稿提交。';
        this.handoff('blocked', detail, null, captureId);
        result = {
          isError: true,
          content: [
            {
              type: 'text',
              text: detail,
            },
          ],
        };
      }
    } else {
      this.send({
        type: 'mcp',
        payload: {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Method not found' },
        },
      });
      return;
    }
    const value = { jsonrpc: '2.0', id: request.id, result };
    this.responses.set(key, { input: serialized, value });
    if (this.responses.size > 100)
      this.responses.delete(this.responses.keys().next().value as string);
    const closing = this.socket;
    this.send(
      { type: 'mcp', payload: value },
      closeAfterReply
        ? () => {
            if (this.socket === closing) this.disconnectTransport();
          }
        : undefined,
    );
  }
  private fail(error: string, recoverable = false) {
    if (this.connectedAt && Date.now() - this.connectedAt >= 30000) this.retryAttempt = 0;
    this.disconnectTransport();
    this.update({ status: 'failed', error });
    if (recoverable) this.retryConnection();
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.connectionLoop = false;
    this.unsubscribe();
    this.disconnect();
    this.closing = Promise.resolve(this.options.wake?.close());
    return this.closing;
  }
  private stopWake(error: string | null = null) {
    if (error) this.update({ wakeAutoSuspended: true });
    const hadWake = this.wakeEnabled;
    if (hadWake && this.state.conversationActive) this.stopConversation(error);
    this.wakeEnabled = false;
    clearInterval(this.wakeLease);
    this.wakeLease = undefined;
    this.options.wake?.stop();
    if ((this.automaticCapture || hadWake) && this.state.status === 'listening')
      void this.command({ action: 'stop-listening' }).catch(() => {});
    if (this.automaticCapture) {
      this.armedUntil = 0;
      this.capturedContext = { selection: null, attachments: [] };
      this.target = '';
    }
    this.automaticCapture = false;
    this.update({
      wake: { ...this.state.wake, status: error ? 'failed' : 'off', detectionId: null, error },
    });
  }
  disconnect() {
    this.update({ wakeAutoSuspended: true });
    this.stopConversation();
    this.stopWake();
    this.disconnectTransport();
  }
  private disconnectTransport() {
    this.connectionEpoch++;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.connectedAt = 0;
    this.stopConversation();
    if (this.wakeEnabled) {
      this.options.wake?.reset();
      this.update({ wake: { ...this.state.wake, status: 'armed', detectionId: null } });
    }
    clearTimeout(this.speechDeadline);
    this.awaitingSpeech = false;
    this.pendingSpeech = '';
    this.lastAnnouncement = '';
    clearTimeout(this.deadline);
    clearTimeout(this.captureDeadline);
    this.deadline = undefined;
    this.captureDeadline = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) socket.terminate();
    this.capturedContext = { selection: null, attachments: [] };
    this.sessionId = '';
    this.armedUntil = 0;
    this.responses.clear();
    this.update({
      status: 'disconnected',
      deviceToolsReady: false,
      connection: { ...this.state.connection, nextRetryAt: null },
    });
    void this.options.desktop?.call('voice-audio', { reset: true }).catch(() => {});
  }
}
