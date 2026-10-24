import { randomUUID } from 'node:crypto';
import {
  type Task,
  type VoiceConfig,
  type WorkbenchState,
  type WorkspaceCommand,
  workbenchSchema,
} from '@lingxi/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { VoiceService } from './voice.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function create(
  format = 'pcm',
  allowed = true,
  wake?: NonNullable<ConstructorParameters<typeof VoiceService>[0]['wake']>,
  reset?: () => Promise<void>,
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  let peer: WebSocket | undefined;
  const frames: unknown[] = [],
    audio: unknown[] = [];
  let headers: Record<string, unknown> = {};
  server.on('connection', (socket, request) => {
    peer = socket;
    headers = request.headers;
    socket.on('message', (data, binary) => {
      if (binary) {
        audio.push(data);
        return;
      }
      const message = JSON.parse(data.toString());
      frames.push(message);
      if (message.type === 'hello')
        socket.send(
          JSON.stringify({
            type: 'hello',
            transport: 'websocket',
            session_id: 'test-session',
            audio_params: { format, sample_rate: 16000, channels: 1 },
          }),
        );
    });
  });
  const projectId = randomUUID();
  let listener: ((state: WorkbenchState) => void) | undefined;
  let state: WorkbenchState = workbenchSchema.parse({
    schemaVersion: 1,
    revision: 0,
    desktop: true,
    project: { id: projectId, name: 'Test', path: '/tmp' },
    task: null,
    preview: null,
  });
  let config: VoiceConfig | undefined = {
    endpoint: 'wss://xrobo-io.qiniuapi.com/v1/ws/',
    deviceId: '02:12:34:56:78:90',
    clientId: randomUUID(),
    token: 'PRIVATE_TOKEN',
    allowVoiceSubmit: allowed,
  };
  const native: Array<{ method: string; params: unknown }> = [];
  const start = vi.fn(
      (id: string, text: string, _selection?: unknown, _attachments?: unknown) =>
        ({ id, prompt: text, status: 'starting' }) as Task,
    ),
    interrupt = vi.fn();
  const command = vi.fn(async (input: WorkspaceCommand, guard?: () => boolean) => {
    if (guard && !guard()) throw new Error('stale');
    if (input.action === 'set-mode')
      state = { ...state, settings: { ...state.settings, plan: input.mode === 'plan' } };
  });
  const voice = new VoiceService({
    ...(wake ? { wake } : {}),
    testEndpoint: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    workbench: {
      voiceContext: () => ({
        selection: null,
        attachments: [
          { id: randomUUID(), kind: 'text', title: '键盘草稿', text: '标题写周末出游' },
        ],
      }),
      read: () => state,
      start,
      command,
      interrupt,
      decide() {},
      subscribe(callback) {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    },
    desktop: {
      async call(method, params) {
        native.push({ method, params });
        if (method === 'voice-config-read') return config ?? null;
        if (method === 'voice-config-save') config = params as VoiceConfig;
        if (method === 'voice-audio' && (params as { reset?: boolean })?.reset) await reset?.();
        return null;
      },
    },
  });
  cleanup.push(async () => {
    voice.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const send = (value: unknown) => peer?.send(JSON.stringify(value));
  const call = async (id: number, name: string, args: unknown = {}) => {
    send({
      type: 'mcp',
      payload: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    });
    await vi.waitFor(() =>
      expect(
        frames.find((f: unknown) => (f as { payload?: { id: number } }).payload?.id === id),
      ).toBeDefined(),
    );
    return (
      frames.find((f: unknown) => (f as { payload?: { id: number } }).payload?.id === id) as {
        payload: { result: { isError?: boolean; content: unknown[] } };
      }
    ).payload.result;
  };
  return {
    voice,
    send,
    sendBinary: (value: Buffer) => peer?.send(value),
    call,
    frames,
    audio,
    native,
    start,
    interrupt,
    command,
    config: () => config,
    headers: () => headers,
    state: (value: Partial<WorkbenchState>) => {
      state = { ...state, ...value };
      listener?.(state);
    },
  };
}
it('authenticates the device, negotiates PCM, uploads only while recording and keeps STT as a draft', async () => {
  const f = await create();
  await f.voice.inspect();
  expect(f.voice.read().configured).toBe(true);
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect(f.headers()).toMatchObject({
    authorization: 'Bearer PRIVATE_TOKEN',
    'protocol-version': '1',
  });
  await expect(f.voice.command({ action: 'connect' })).rejects.toThrow('voice_already_connected');
  const pcm = Buffer.alloc(640).toString('base64');
  f.voice.frame(pcm);
  await f.voice.command({ action: 'listen' });
  f.voice.frame('too short');
  f.voice.frame('a'.repeat(901));
  f.voice.frame(pcm);
  f.send({ type: 'stt', session_id: 'wrong-session', text: 'ignored' });
  f.send({ type: 'stt', session_id: 'test-session', text: '做一个页面' });
  await vi.waitFor(() => expect(f.voice.read().draft).toBe('做一个页面'));
  expect(f.start).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(f.audio).toHaveLength(1));
  await f.voice.command({ action: 'stop-listening' });
  f.voice.frame(pcm);
  expect(f.voice.read().status).toBe('ready');
  await f.voice.command({ action: 'speak', text: '本轮任务完成' });
  await vi.waitFor(() =>
    expect(f.frames).toContainEqual(expect.objectContaining({ text_response: '本轮任务完成' })),
  );
  f.send({ type: 'tts', state: 'start' });
  f.send({ type: 'tts', state: 'sentence_start', text: '语音回复' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('speaking'));
  expect(f.voice.read().subtitle).toBe('语音回复');
  await f.voice.command({ action: 'stop-speaking' });
  expect(f.interrupt).not.toHaveBeenCalled();
  expect(JSON.stringify(f.voice.read())).not.toContain('PRIVATE_TOKEN');
});
it('routes encapsulated device MCP once per capture, rejects changed contexts and never grants arbitrary operations', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  f.send({ type: 'mcp', payload: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
  f.send({ type: 'mcp', payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  f.send({ type: 'mcp', payload: { jsonrpc: '2.0', id: 3, method: 'arbitrary/shell' } });
  expect((await f.call(4, 'workbench_submit', { text: 'too early' })).isError).toBe(true);
  await f.voice.command({ action: 'listen' });
  const context = randomUUID();
  f.state({ selectedThreadId: context });
  expect((await f.call(5, 'workbench_submit', { text: 'wrong conversation' })).isError).toBe(true);
  f.state({ selectedThreadId: null });
  await f.voice.command({ action: 'stop-listening' });
  expect((await f.call(6, 'workbench_submit', { text: 'build' })).isError).toBeUndefined();
  await f.call(6, 'workbench_submit', { text: 'build' });
  await f.call(7, 'workbench_submit', { text: 'build' });
  expect(f.start).toHaveBeenCalledTimes(2); // Same capture id reaches the durable Workbench deduplication.
  expect(f.start.mock.calls[0]?.[0]).toBe(f.start.mock.calls[1]?.[0]);
  expect(f.start.mock.calls[0]?.[3]).toMatchObject([{ title: '键盘草稿', text: '标题写周末出游' }]);
  expect((await f.call(8, 'workbench_submit', { text: 'different task' })).isError).toBe(true);
  await f.call(9, 'workbench_interrupt');
  expect(f.interrupt).toHaveBeenCalledOnce();
  expect((await f.call(10, 'workbench_status')).content).toBeDefined();
  expect((await f.call(11, 'arbitrary-shell', { command: 'rm' })).isError).toBe(true);
  f.send({ type: 'tts', state: 'start' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('speaking'));
  // Binary PCM playback is carried only across private desktop IPC.
  f.sendBinary(Buffer.alloc(640));
  await vi.waitFor(() =>
    expect(
      f.native.some(
        (event) => event.method === 'voice-audio' && (event.params as { pcm?: string })?.pcm,
      ),
    ).toBe(true),
  );
  const serverFrames = f.native.length;
  f.send({ type: 'tts', state: 'stop', is_aborted: true });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect(f.native.length).toBeGreaterThan(serverFrames);
  await f.voice.command({ action: 'disconnect' });
  expect(f.voice.read().status).toBe('disconnected');
});
it('switches modes only through armed device MCP and never lets speech elevate permissions', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect((await f.call(30, 'workbench_set_mode', { mode: 'plan' })).isError).toBe(true);
  await f.voice.command({ action: 'listen' });
  f.send({ type: 'stt', text: '切换到计划模式' });
  await vi.waitFor(() => expect(f.voice.read().draft).toBe('切换到计划模式'));
  expect(f.command).not.toHaveBeenCalled();
  await f.voice.command({ action: 'stop-listening' });
  expect((await f.call(31, 'workbench_set_mode', { mode: 'plan' })).isError).toBeUndefined();
  await f.call(31, 'workbench_set_mode', { mode: 'plan' });
  expect(f.command).toHaveBeenCalledTimes(1);
  expect(f.command.mock.calls[0]?.[0]).toEqual({ action: 'set-mode', mode: 'plan' });
  expect(f.start).not.toHaveBeenCalled();
  expect((await f.call(32, 'workbench_set_mode', { mode: 'full-access' })).isError).toBe(true);
  expect((await f.call(33, 'workbench_set_mode', { mode: 'default' })).isError).toBe(true);
  await f.voice.command({ action: 'listen' });
  expect((await f.call(34, 'workbench_set_mode', { mode: 'default' })).isError).toBeUndefined();
  expect(f.command).toHaveBeenCalledTimes(2);
});
it('requires explicit permission for voice submission and can save preferences without exposing the token', async () => {
  const f = await create('pcm', false);
  await f.voice.inspect();
  await f.voice.preferences(true);
  expect(f.config()?.allowVoiceSubmit).toBe(true);
  await f.voice.preferences(false);
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'listen' });
  expect((await f.call(1, 'workbench_submit', { text: 'disallowed' })).isError).toBe(true);
  expect(f.start).not.toHaveBeenCalled();
});
it('rejects unsupported negotiated formats instead of playing Opus as PCM', async () => {
  const { voice } = await create('opus');
  await voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(voice.read().status).toBe('failed'));
  expect(voice.read().error).toContain('PCM');
  await expect(voice.command({ action: 'listen' })).rejects.toThrow('voice_not_ready');
});
it('rejects untrusted events without disclosing raw payloads', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  f.send({ type: 'stt', text: 'no activation' });
  expect(f.voice.read().draft).toBe('');
  f.send({ type: 'tts', state: 'PRIVATE_INVALID_STATE' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('failed'));
  expect(f.voice.read().error).not.toContain('PRIVATE');
  const bare = new VoiceService({
    workbench: {
      async command() {},
      voiceContext: () => ({ selection: null, attachments: [] }),
      read: () =>
        workbenchSchema.parse({
          schemaVersion: 1,
          revision: 0,
          desktop: false,
          project: null,
          task: null,
          preview: null,
        }),
      start: vi.fn(),
      interrupt() {},
      decide() {},
      subscribe() {
        return () => {};
      },
    },
  });
  expect((await bare.inspect()).configured).toBe(false);
  await expect(bare.save({})).rejects.toThrow('desktop_required');
  await expect(bare.command({ action: 'connect' })).rejects.toThrow('desktop_required');
});
it('announces real completion and questions once, queues while recording, and separates speech from task cancellation', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    projectId: randomUUID(),
    prompt: 'work',
    selection: null,
    status: 'completed',
    threadId: 'thread',
    turnId: 'turn',
    messages: [{ id: 'reply', text: 'PRIVATE text should not be read aloud' }],
    activity: 'completed',
    approval: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await f.voice.command({ action: 'listen' });
  f.state({ task: { ...task, status: 'running' } });
  f.state({ task });
  f.state({ task });
  expect(
    f.frames.filter((v: unknown) => !!(v as { text_response?: string }).text_response),
  ).toHaveLength(0);
  await f.voice.command({ action: 'stop-listening' });
  await vi.waitFor(() =>
    expect(
      f.frames.filter((v: unknown) => !!(v as { text_response?: string }).text_response),
    ).toHaveLength(1),
  );
  expect(JSON.stringify(f.frames)).not.toContain('PRIVATE text');
  f.send({ type: 'tts', state: 'start' });
  f.send({ type: 'tts', state: 'stop' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  f.state({
    task: {
      ...task,
      status: 'waiting',
      approval: {
        id: 'question',
        kind: 'question',
        title: 'Question',
        detail: '',
        questions: [{ id: 'color', question: '什么颜色？', isSecret: false }],
      },
    },
  });
  await vi.waitFor(() => expect(JSON.stringify(f.frames)).toContain('什么颜色？'));
  expect(f.interrupt).not.toHaveBeenCalled();
});

function wakePeer() {
  let detection = () => {},
    failure = () => {};
  return {
    installed: vi.fn(async () => true),
    install: vi.fn(async () => {}),
    start: vi.fn(async (_keyword: string, detected: () => void, failed: () => void) => {
      detection = detected;
      failure = failed;
    }),
    frame: vi.fn(),
    reset: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(),
    detect: () => detection(),
    fail: () => failure(),
  };
}
it('keeps idle wake audio local, requires a staged capture after detection, and ends speech on silence', async () => {
  const wake = wakePeer(),
    f = await create('pcm', true, wake);
  await f.voice.inspect();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'arm-wake', keyword: '丽塔同学' });
  const quiet = Buffer.alloc(640).toString('base64');
  f.voice.frame(quiet);
  expect(wake.frame).toHaveBeenCalledTimes(1);
  expect(f.audio).toHaveLength(0);
  wake.detect();
  expect(f.voice.read().wake.status).toBe('detected');
  expect(f.voice.read().status).toBe('ready');
  expect(f.start).not.toHaveBeenCalled();
  f.voice.frame(quiet);
  expect(wake.frame).toHaveBeenCalledTimes(1);
  expect(f.audio).toHaveLength(0);
  await f.voice.command({ action: 'listen' });
  const loud = Buffer.alloc(640);
  for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(5000, i);
  for (let i = 0; i < 20; i++) f.voice.frame(loud.toString('base64'));
  for (let i = 0; i < 100; i++) f.voice.frame(quiet);
  expect(f.voice.read().status).toBe('processing');
  expect(f.voice.read().conversationActive).toBe(true);
  f.send({ type: 'tts', state: 'start' });
  f.send({ type: 'tts', state: 'stop' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect(f.voice.read().wake.status).toBe('armed');
  expect(wake.reset).toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(
      f.frames.some((value) => {
        const message = value as { type?: string; state?: string };
        return message.type === 'listen' && message.state === 'stop';
      }),
    ).toBe(true),
  );
  expect(f.audio.length).toBeGreaterThan(0);
  const count = f.audio.length;
  f.voice.frame(quiet);
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.audio).toHaveLength(count);
  await f.voice.command({ action: 'stop-wake' });
  expect(f.voice.read().wake.status).toBe('off');
  expect(wake.stop).toHaveBeenCalled();
  expect(
    (await f.call(700, 'workbench_submit', { text: 'late command after disabling wake' })).isError,
  ).toBe(true);
  expect(f.start).not.toHaveBeenCalled();
  await f.voice.command({ action: 'arm-wake', keyword: '丽塔同学' });
  await f.voice.command({ action: 'listen' });
  await f.voice.command({ action: 'stop-wake' });
  expect(f.voice.read().status).toBe('ready');
});
it('disarms wake detection on engine errors, lost microphone leases and disconnect', async () => {
  const wake = wakePeer(),
    f = await create('pcm', true, wake);
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'arm-wake', keyword: '丽塔同学' });
  wake.fail();
  expect(f.voice.read().wake.status).toBe('failed');
  await f.voice.command({ action: 'arm-wake', keyword: '你好丽塔同学' });
  const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10000);
  try {
    await vi.waitFor(() => expect(f.voice.read().wake.status).toBe('failed'), { timeout: 2000 });
  } finally {
    time.mockRestore();
  }
  expect(f.voice.read().wake.error).toContain('麦克风');
  await f.voice.command({ action: 'arm-wake', keyword: '丽塔同学' });
  f.voice.disconnect();
  expect(f.voice.read().wake.status).toBe('off');
  wake.detect();
  expect(f.voice.read().wake.status).toBe('off');
});
it('reports wake installation/start failures without opening an upload capture', async () => {
  const wake = wakePeer(),
    f = await create('pcm', true, wake);
  wake.install.mockRejectedValueOnce(new Error('network'));
  await f.voice.command({ action: 'install-wake' });
  expect(f.voice.read().wake.status).toBe('failed');
  await f.voice.command({ action: 'install-wake' });
  expect(f.voice.read().wake.installed).toBe(true);
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  wake.start.mockRejectedValueOnce(new Error('engine'));
  await f.voice.command({ action: 'arm-wake', keyword: '丽塔同学' });
  expect(f.voice.read().wake.status).toBe('failed');
  expect(f.voice.read().status).toBe('ready');
  expect(f.audio).toHaveLength(0);
});
it('times out an empty wake capture and only accepts context detail voice controls within consent and capture', async () => {
  const wake = wakePeer(),
    f = await create('pcm', true, wake);
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect((await f.call(600, 'workbench_context_details', { open: true })).isError).toBe(true);
  await f.voice.command({ action: 'arm-wake', keyword: '丽塔同学' });
  wake.detect();
  await f.voice.command({ action: 'listen' });
  expect((await f.call(601, 'workbench_context_details', { open: true })).isError).not.toBe(true);
  expect(f.voice.read().contextDetailsOpen).toBe(true);
  expect(f.start).not.toHaveBeenCalled();
  for (let i = 0; i < 400; i++) f.voice.frame(Buffer.alloc(640).toString('base64'));
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect(
    (await f.call(602, 'workbench_submit', { text: 'late command after silence' })).isError,
  ).toBe(true);
  await f.voice.command({ action: 'context-details', open: false });
  expect(f.voice.read().contextDetailsOpen).toBe(false);
});
it('shows draft-only mode and explains denied handoff without starting Codex', async () => {
  const f = await create('pcm', false);
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'listen' });
  f.send({ type: 'stt', text: '把这个页面变成粉色' });
  await vi.waitFor(() => expect(f.voice.read().draft).toBe('把这个页面变成粉色'));
  expect(f.voice.read().handoff?.status).toBe('draft-only');
  const refused = await f.call(801, 'workbench_submit', { text: '把这个页面变成粉色' });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused)).toContain('尚未开启语音执行');
  expect(f.voice.read().handoff).toMatchObject({ status: 'blocked', taskId: null });
  expect(f.start).not.toHaveBeenCalled();
});
it('reports discovered device tools and an agent refusal as not handed to Codex', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  f.send({ type: 'mcp', payload: { jsonrpc: '2.0', id: 802, method: 'initialize' } });
  f.send({ type: 'mcp', payload: { jsonrpc: '2.0', id: 803, method: 'tools/list' } });
  await vi.waitFor(() => expect(f.voice.read().deviceToolsReady).toBe(true));
  const initialization = f.frames.find(
    (value) => (value as { payload?: { id: number } }).payload?.id === 802,
  );
  expect(JSON.stringify(initialization)).toContain('把这个页面变成粉色');
  const listing = f.frames.find(
    (value) => (value as { payload?: { id: number } }).payload?.id === 803,
  );
  expect(JSON.stringify(listing)).toContain('把这个页面变成粉色');
  await f.voice.command({ action: 'listen' });
  f.send({ type: 'stt', text: '把这个页面变成粉色' });
  await vi.waitFor(() => expect(f.voice.read().draft).toBe('把这个页面变成粉色'));
  await f.voice.command({ action: 'stop-listening' });
  f.send({ type: 'tts', state: 'start' });
  f.send({ type: 'tts', state: 'sentence_start', text: '我做不到' });
  f.send({ type: 'tts', state: 'stop' });
  await vi.waitFor(() => expect(f.voice.read().handoff?.status).toBe('unhandled'));
  expect(f.voice.read().handoff?.message).toContain('没有提交给 Codex');
  expect(f.start).not.toHaveBeenCalled();
});
it('only reports submission after a real receipt and resets the next capture', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'listen' });
  const id = f.voice.read().captureId;
  await f.call(804, 'workbench_submit', { text: '把这个页面变成粉色' });
  expect(f.voice.read().handoff).toMatchObject({ status: 'submitted', taskId: id, captureId: id });
  expect(f.start.mock.calls[0]?.[1]).toBe('把这个页面变成粉色');
  await f.call(805, 'workbench_submit', { text: 'another task' });
  expect(f.voice.read().handoff?.status).toBe('submitted');
  await f.voice.command({ action: 'stop-listening' });
  await f.voice.command({ action: 'listen' });
  expect(f.voice.read().handoff).toMatchObject({ status: 'awaiting-tool', taskId: null });
  expect(f.voice.read().handoff?.captureId).not.toBe(id);
});
it('rejects stale transcripts and projects missing on submission with specific public reasons', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'listen' });
  f.state({ selectedThreadId: randomUUID() });
  f.send({ type: 'stt', text: 'late speech from another conversation' });
  await vi.waitFor(() => expect(f.voice.read().handoff?.status).toBe('blocked'));
  expect(f.voice.read().draft).toBe('');
  expect(f.start).not.toHaveBeenCalled();
  await f.voice.command({ action: 'stop-listening' });
  await f.voice.command({ action: 'listen' });
  f.start.mockImplementationOnce(() => {
    throw new Error('project_required');
  });
  const result = await f.call(806, 'workbench_submit', { text: 'pink' });
  expect(JSON.stringify(result)).toContain('尚未选择项目');
  expect(f.voice.read().handoff?.status).toBe('blocked');
});
it('can set a session wake keyword without connecting or opening the microphone', async () => {
  const wake = wakePeer(),
    f = await create('pcm', true, wake);
  await f.voice.command({ action: 'wake-keyword', keyword: '你好同学' });
  expect(f.voice.read().wake.keyword).toBe('你好同学');
  expect(f.voice.read().status).toBe('disconnected');
  expect(wake.start).not.toHaveBeenCalled();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'arm-wake', keyword: '你好同学' });
  await expect(f.voice.command({ action: 'wake-keyword', keyword: '丽塔同学' })).rejects.toThrow(
    'wake_active',
  );
});
it('keeps an explicitly opened conversation through long silence without uploading idle audio or granting tasks', async () => {
  const f = await create('pcm', false);
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  vi.useFakeTimers();
  await f.voice.command({ action: 'start-session' });
  const quiet = Buffer.alloc(640).toString('base64');
  for (let second = 0; second < 125; second++) {
    f.voice.frame(quiet);
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(f.voice.read()).toMatchObject({
    status: 'ready',
    conversationActive: true,
    speechId: null,
  });
  expect(f.audio).toHaveLength(0);
  expect(f.start).not.toHaveBeenCalled();
  await f.voice.command({ action: 'stop-session' });
  f.voice.frame(quiet);
  expect(f.voice.read().conversationActive).toBe(false);
  vi.useRealTimers();
});
it('stages a new bounded speech capture after idle, retains initial speech and continues after a response', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'start-session' });
  const loud = Buffer.alloc(640);
  for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(5000, i);
  const quiet = Buffer.alloc(640).toString('base64');
  for (let i = 0; i < 5; i++) f.voice.frame(loud.toString('base64'));
  expect(f.voice.read().speechId).toBeTruthy();
  expect(f.audio).toHaveLength(0);
  await f.voice.command({ action: 'listen' });
  const captureId = f.voice.read().captureId;
  await vi.waitFor(() => expect(f.audio).toHaveLength(5));
  for (let i = 0; i < 15; i++) f.voice.frame(loud.toString('base64'));
  for (let i = 0; i < 100; i++) f.voice.frame(quiet);
  expect(f.voice.read().status).toBe('processing');
  f.send({ type: 'tts', state: 'start' });
  f.send({ type: 'tts', state: 'stop' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect(f.voice.read().conversationActive).toBe(true);
  for (let i = 0; i < 5; i++) f.voice.frame(loud.toString('base64'));
  await f.voice.command({ action: 'listen' });
  expect(f.voice.read().captureId).not.toBe(captureId);
  expect(f.start).not.toHaveBeenCalled();
});
it('allows an explicit spoken close without task permission and never reopens after disconnect', async () => {
  const f = await create('pcm', false);
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect((await f.call(900, 'workbench_voice_close', {})).isError).toBe(true);
  await f.voice.command({ action: 'listen' });
  expect((await f.call(901, 'workbench_voice_close', {})).isError).not.toBe(true);
  expect(f.voice.read().conversationActive).toBe(false);
  expect(f.start).not.toHaveBeenCalled();
  f.send({ type: 'tts', state: 'start' });
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.voice.read().status).toBe('ready');
  await f.voice.command({ action: 'disconnect' });
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect(f.voice.read().conversationActive).toBe(false);
});
it('ends the active microphone lease when audio is lost, not when frames are silent', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  vi.useFakeTimers();
  await f.voice.command({ action: 'start-session' });
  await vi.advanceTimersByTimeAsync(6000);
  expect(f.voice.read()).toMatchObject({ conversationActive: false, status: 'ready' });
  expect(f.voice.read().error).toContain('麦克风音频已中断');
});
it('does not reopen a capture whose audio setup finishes after an explicit close', async () => {
  let release = () => {};
  const pendingReset = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await create('pcm', true, undefined, () => pendingReset);
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  const listening = f.voice.command({ action: 'listen' });
  const rejected = expect(listening).rejects.toThrow('voice_capture_cancelled');
  const stopping = f.voice.command({ action: 'stop-session' });
  release();
  await Promise.all([rejected, stopping]);
  expect(f.voice.read()).toMatchObject({
    conversationActive: false,
    status: 'ready',
    captureId: null,
  });
  expect(f.start).not.toHaveBeenCalled();
});
