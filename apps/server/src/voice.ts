import { randomUUID } from 'node:crypto';
import {
  type VoiceCommand,
  type VoiceConfig,
  type VoiceState,
  voiceConfigSchema,
} from '@lingxi/protocol';
import WebSocket from 'ws';
import { z } from 'zod';
import type { DesktopBridge } from './desktop-bridge.js';
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

// Lingxi is the MCP client; this Mac is its device MCP server, encapsulated in
// the outbound WSS. It is separate from Codex's authenticated preview MCP.
export class VoiceService {
  private socket: WebSocket | undefined;
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
  private responses = new Map<string, { input: string; value: unknown }>();
  private state: VoiceState = {
    configured: false,
    status: 'disconnected',
    draft: '',
    captureId: null,
    subtitle: '',
    error: null,
    allowVoiceSubmit: false,
  };
  constructor(
    private options: {
      desktop?: DesktopBridge;
      workbench: Pick<
        Workbench,
        'read' | 'start' | 'interrupt' | 'decide' | 'subscribe' | 'voiceContext' | 'command'
      >;
      testEndpoint?: string;
    },
  ) {
    this.unsubscribe = options.workbench.subscribe(() => this.observeTask());
  }
  private observeTask() {
    const task = this.options.workbench.read().task;
    const previous = this.previousTask;
    this.previousTask = task ? { id: task.id, status: task.status } : null;
    if (!this.socket) return;
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
    return this.state;
  }
  private update(value: Partial<VoiceState>) {
    this.state = { ...this.state, ...value };
  }
  async save(input: unknown) {
    if (!this.options.desktop) throw new Error('desktop_required');
    const config = voiceConfigSchema.parse(input);
    await this.options.desktop.call('voice-config-save', config);
    this.disconnect();
    this.config = config;
    this.update({ configured: true, allowVoiceSubmit: config.allowVoiceSubmit });
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
    });
    return this.state;
  }
  async command(command: VoiceCommand) {
    if (!this.options.desktop) throw new Error('desktop_required');
    if (command.action === 'connect') {
      await this.connect();
      return;
    }
    if (command.action === 'disconnect') {
      this.disconnect();
      return;
    }
    if (!this.socket || !['ready', 'listening', 'speaking'].includes(this.state.status))
      throw new Error('voice_not_ready');
    if (command.action === 'listen') {
      const context = this.options.workbench.voiceContext(),
        target = this.context();
      this.send({ type: 'abort', reason: 'wake_word_detected' });
      await this.options.desktop.call('voice-audio', { reset: true });
      if (target !== this.context()) throw new Error('voice_context_changed');
      this.update({
        status: 'listening',
        captureId: randomUUID(),
        draft: '',
        subtitle: '',
        error: null,
      });
      this.target = target;
      this.capturedContext = context;
      this.armedUntil = Date.now() + 90_000;
      this.submittedCapture = null;
      this.modeInCapture = null;
      this.send({ type: 'listen', state: 'start', mode: 'manual' });
      clearTimeout(this.captureDeadline);
      this.captureDeadline = setTimeout(() => {
        void this.command({ action: 'stop-listening' }).catch(() => {});
      }, 60000);
    } else if (command.action === 'stop-listening') {
      if (this.state.status !== 'listening') throw new Error('voice_not_listening');
      clearTimeout(this.captureDeadline);
      this.captureDeadline = undefined;
      this.send({ type: 'listen', state: 'stop', mode: 'manual' });
      this.armedUntil = Date.now() + 30000;
      this.update({ status: 'ready' });
      this.flushSpeech();
    } else if (command.action === 'stop-speaking') {
      this.pendingSpeech = '';
      this.awaitingSpeech = false;
      clearTimeout(this.speechDeadline);
      this.send({ type: 'abort', reason: 'user_requested' });
      await this.options.desktop.call('voice-audio', { reset: true });
      this.update({ status: 'ready', subtitle: '' });
    } else {
      this.send({
        type: 'listen',
        state: 'detect',
        text: '工作台状态播报',
        text_response: command.text,
      });
    }
  }
  private async connect() {
    if (this.socket) throw new Error('voice_already_connected');
    if (!this.config) await this.inspect();
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
    this.deadline = setTimeout(() => this.fail('语音握手超时，请检查设备绑定与网络。'), 10000);
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
        this.fail('灵矽返回了不兼容的消息，请检查服务配置。');
      }
    });
    socket.on('error', () => {
      if (this.socket === socket) this.fail('无法连接灵矽，请核对令牌、设备绑定与网络。');
    });
    socket.on('close', () => {
      if (this.socket === socket) this.fail('灵矽连接已断开，请重新连接。');
    });
  }
  frame(base64: string) {
    // Exactly 20 ms of PCM16LE mono at 16kHz, accepted only while explicitly
    // recording. No audio is stored or uploaded in the idle state.
    if (this.state.status !== 'listening' || !this.socket || base64.length > 900) return;
    const pcm = Buffer.from(base64, 'base64');
    if (pcm.length !== 640 || this.socket.bufferedAmount > 64000) return;
    this.socket.send(pcm);
  }
  private send(value: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(
        JSON.stringify({ ...(this.sessionId ? { session_id: this.sessionId } : {}), ...value }),
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
        this.fail('服务未协商 PCM 16kHz 单声道，请在灵矽配置 PCM；本版不把 Opus 音频当 PCM 播放。');
        return;
      }
      clearTimeout(this.deadline);
      this.deadline = undefined;
      this.sessionId = message.session_id ?? '';
      this.update({ status: 'ready', error: null });
    } else if (message.type === 'stt') {
      if (!this.state.captureId || Date.now() > this.armedUntil) return;
      const text = z.string().max(4000).parse(message.text);
      this.update({ draft: text }); // STT alone never executes a task.
    } else if (message.type === 'tts') {
      const event = z
        .object({
          state: z.enum(['start', 'stop', 'sentence_start']),
          text: z.string().max(4000).optional(),
          is_aborted: z.boolean().optional(),
        })
        .parse(message);
      if (event.state === 'start' && this.state.status !== 'listening') {
        clearTimeout(this.speechDeadline);
        this.awaitingSpeech = false;
        this.update({ status: 'speaking' });
      }
      if (event.state === 'sentence_start') this.update({ subtitle: event.text ?? '' });
      if (event.state === 'stop') {
        if (event.is_aborted)
          void this.options.desktop?.call('voice-audio', { reset: true }).catch(() => {});
        if (this.state.status === 'speaking') {
          this.update({ status: 'ready' });
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
    if (request.method === 'initialize')
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'lingxi-workbench-device', version: '0.2.0' },
      };
    else if (request.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'workbench_status',
            description: '读取当前项目、任务进度和待回答问题。',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
          {
            name: 'workbench_submit',
            description:
              '用户明确要求提交开发任务时调用。仅在用户主动收音且已允许语音提交时可用；一次收音最多一个任务。',
            inputSchema: z.toJSONSchema(textInput),
          },
          {
            name: 'workbench_set_mode',
            description:
              '用户明确说切换到计划模式或执行模式时调用，只影响新提交任务。仅在主动收音并允许语音控制时可用。不修改权限，不提交开发任务。',
            inputSchema: z.toJSONSchema(modeInput),
          },
          {
            name: 'workbench_interrupt',
            description: '用户明确要求停止当前 Codex 任务时调用。不会回退代码。',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      };
    else if (request.method === 'tools/call') {
      try {
        const call = z
          .object({
            name: z.enum([
              'workbench_status',
              'workbench_submit',
              'workbench_interrupt',
              'workbench_set_mode',
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
                  questions: state.task?.approvals
                    ?.filter((a) => a.kind === 'question')
                    .flatMap((a) => a.questions?.filter((q) => !q.isSecret) ?? []),
                }),
              },
            ],
          };
        } else {
          if (
            !this.config?.allowVoiceSubmit ||
            !this.state.captureId ||
            Date.now() > this.armedUntil
          )
            throw new Error('not_armed');
          if (this.target !== this.context()) throw new Error('voice_context_changed');
          if (call.name === 'workbench_set_mode') {
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
            result = {
              content: [{ type: 'text', text: '已请求停止 Codex。已产生的文件修改保留。' }],
            };
          }
        }
      } catch {
        result = {
          isError: true,
          content: [
            {
              type: 'text',
              text: '操作未执行。请确认已主动收音、允许语音提交并选中正确的项目和对话；也可在操作台提交。',
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
    this.send({ type: 'mcp', payload: value });
  }
  private fail(error: string) {
    this.disconnect();
    this.update({ status: 'failed', error });
  }
  close() {
    this.unsubscribe();
    this.disconnect();
  }
  disconnect() {
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
    this.update({ status: 'disconnected' });
    void this.options.desktop?.call('voice-audio', { reset: true }).catch(() => {});
  }
}
