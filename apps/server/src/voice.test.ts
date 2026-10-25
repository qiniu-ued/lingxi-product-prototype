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
import { WakePreferences } from './wake-preferences.js';

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
  preferences?: WakePreferences,
  permission = 'granted',
  connectionPreferences?: WakePreferences,
) {
  let deniedAuthentication = false,
    connections = 0;
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    autoPong: false,
    verifyClient: (_info, done) => {
      if (deniedAuthentication) done(false, 401);
      else done(true);
    },
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  let peer: WebSocket | undefined;
  let accepting = true,
    pings = 0,
    pongEnabled = true;
  const frames: unknown[] = [],
    audio: unknown[] = [];
  let headers: Record<string, unknown> = {};
  server.on('connection', (socket, request) => {
    connections++;
    if (!accepting) {
      socket.terminate();
      return;
    }
    peer = socket;
    socket.on('ping', (data) => {
      pings++;
      if (pongEnabled) socket.pong(data);
    });
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
    ...(preferences ? { wakePreferences: preferences } : {}),
    ...(connectionPreferences ? { connectionPreferences } : {}),
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
        if (method === 'microphone-status') return permission;
        if (method === 'voice-config-read') return config ?? null;
        if (method === 'voice-config-save') config = params as VoiceConfig;
        if (method === 'voice-audio' && (params as { reset?: boolean })?.reset) await reset?.();
        return null;
      },
    },
  });
  cleanup.push(async () => {
    voice.close();
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
    drop: () => peer?.terminate(),
    remoteClose: (code: number, reason: string) => peer?.close(code, reason),
    connections: () => connections,
    denyAuthentication: () => {
      deniedAuthentication = true;
    },
    removeConfiguration: () => {
      config = undefined;
    },
    setAccepting: (accept: boolean) => {
      accepting = accept;
    },
    pingCount: () => pings,
    ignorePongs: () => {
      pongEnabled = false;
    },
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
it('respects a saved voice-execution choice and can change it without exposing the token', async () => {
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
  expect(f.voice.read().status).toBe('disconnected');
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
  expect(f.voice.diagnostics().events).toContainEqual(
    expect.objectContaining({
      kind: 'voice-paused',
      source: 'microphone',
      reason: 'audio_frames_lost',
    }),
  );
  expect(f.voice.diagnostics().events.some((event) => event.kind === 'service-failed')).toBe(false);
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
    status: 'disconnected',
    captureId: null,
  });
  expect(f.start).not.toHaveBeenCalled();
});
it('starts local default wake without connecting or uploading and requires existing microphone authorization', async () => {
  const wake = wakePeer(),
    prefs = new WakePreferences(null),
    f = await create('pcm', false, wake, undefined, prefs);
  await f.voice.inspect();
  await f.voice.command({ action: 'arm-wake', keyword: '丽塔同学', automatic: true });
  expect(f.voice.read()).toMatchObject({
    status: 'disconnected',
    wake: { status: 'armed', keyword: '丽塔同学' },
  });
  f.voice.frame(Buffer.alloc(640).toString('base64'));
  expect(wake.frame).toHaveBeenCalledTimes(1);
  expect(f.frames).toHaveLength(0);
  expect(f.audio).toHaveLength(0);
  expect(f.start).not.toHaveBeenCalled();
  wake.detect();
  expect(f.voice.read().wake.status).toBe('detected');
  expect(f.frames).toHaveLength(0);
  await f.voice.command({ action: 'dismiss-wake' });
  expect(f.voice.read().wake.status).toBe('armed');
  await f.voice.command({ action: 'pause-voice', suspend: false });
  expect(prefs.read().enabled).toBe(true);
  await f.voice.command({ action: 'stop-wake' });
  expect(prefs.read()).toMatchObject({ enabled: false, source: 'user' });
  await expect(
    f.voice.command({ action: 'arm-wake', keyword: '丽塔同学', automatic: true }),
  ).rejects.toThrow('wake_auto_not_ready');
});
it('refuses automatic wake for denied permission, explicit off or suspended audio without creating a provider session', async () => {
  const disabled = new WakePreferences(null);
  disabled.save(false);
  for (const [prefs, permission] of [
    [new WakePreferences(null), 'denied'],
    [disabled, 'granted'],
  ] as const) {
    const wake = wakePeer(),
      f = await create('pcm', true, wake, undefined, prefs, permission);
    await expect(
      f.voice.command({ action: 'arm-wake', keyword: '丽塔同学', automatic: true }),
    ).rejects.toThrow('wake_auto_not_ready');
    expect(wake.start).not.toHaveBeenCalled();
    expect(f.frames).toHaveLength(0);
  }
  const prefs = new WakePreferences(null),
    wake = wakePeer(),
    f = await create('pcm', true, wake, undefined, prefs);
  await f.voice.command({ action: 'pause-voice' });
  await expect(
    f.voice.command({ action: 'arm-wake', keyword: '丽塔同学', automatic: true }),
  ).rejects.toThrow('wake_auto_not_ready');
  await f.voice.command({ action: 'wake-auto', enabled: true });
  await f.voice.command({ action: 'arm-wake', keyword: '丽塔同学', automatic: true });
  expect(f.voice.read().wake.status).toBe('armed');
});
it('connects a configured device on startup and keeps quiet sessions alive using ping, without PCM upload', async () => {
  const f = await create(
    'pcm',
    false,
    undefined,
    undefined,
    undefined,
    'granted',
    new WakePreferences(null),
  );
  vi.useFakeTimers();
  await f.voice.startAutoConnection();
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(20000);
    await vi.waitFor(() => expect(f.pingCount()).toBeGreaterThan(i));
  }
  expect(f.voice.read().status).toBe('ready');
  expect(f.audio).toHaveLength(0);
  expect(f.start).not.toHaveBeenCalled();
  f.voice.close();
  await vi.advanceTimersByTimeAsync(120000);
  await f.voice.startAutoConnection();
  expect(f.connections()).toBe(1);
});
it('backs off after an unexpected drop and cancels retries after the user disconnects', async () => {
  const prefs = new WakePreferences(null),
    f = await create('pcm', true, undefined, undefined, undefined, 'granted', prefs);
  vi.useFakeTimers();
  await f.voice.startAutoConnection();
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  f.drop();
  await vi.waitFor(() => expect(f.voice.read().connection.nextRetryAt).not.toBeNull());
  expect(f.voice.read().connection.attempt).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect(f.connections()).toBe(2);
  await f.voice.command({ action: 'disconnect' });
  expect(prefs.read().enabled).toBe(false);
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.connections()).toBe(2);
  expect(f.voice.read().status).toBe('disconnected');
  expect(f.audio).toHaveLength(0);
});
it('limits consecutive failures and requires explicit recovery instead of retrying densely forever', async () => {
  const f = await create(
    'pcm',
    true,
    undefined,
    undefined,
    undefined,
    'granted',
    new WakePreferences(null),
  );
  f.setAccepting(false);
  vi.useFakeTimers();
  await f.voice.startAutoConnection();
  await vi.waitFor(() => expect(f.voice.read().connection.attempt).toBe(1));
  for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 30000].entries()) {
    await vi.advanceTimersByTimeAsync(delay);
    await vi.waitFor(() => expect(f.voice.read().connection.attempt).toBe(Math.min(index + 2, 6)));
  }
  await vi.waitFor(() => expect(f.voice.read().connection.exhausted).toBe(true));
  expect(f.connections()).toBe(7);
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.connections()).toBe(7);
  f.setAccepting(true);
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect(f.voice.read().connection.exhausted).toBe(false);
});
it('does not retry authentication failure or manufacture a binding for a missing configuration', async () => {
  const f = await create(
    'pcm',
    true,
    undefined,
    undefined,
    undefined,
    'granted',
    new WakePreferences(null),
  );
  f.denyAuthentication();
  await f.voice.startAutoConnection();
  await vi.waitFor(() => expect(f.voice.read().status).toBe('failed'));
  expect(f.voice.read().error).toContain('认证未通过');
  expect(f.voice.read().connection.nextRetryAt).toBeNull();
  const missing = await create(
    'pcm',
    true,
    undefined,
    undefined,
    undefined,
    'granted',
    new WakePreferences(null),
  );
  missing.removeConfiguration();
  await missing.voice.startAutoConnection();
  expect(missing.voice.read()).toMatchObject({ configured: false, status: 'disconnected' });
  expect(missing.connections()).toBe(0);
});
it('a transport failure or explicit service disconnect does not upload idle wake audio or replay a capture', async () => {
  const wake = wakePeer(),
    prefs = new WakePreferences(null),
    connectionPrefs = new WakePreferences(null);
  const f = await create('pcm', true, wake, undefined, prefs, 'granted', connectionPrefs);
  await f.voice.startAutoConnection();
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'arm-wake', keyword: '丽塔同学', automatic: true });
  f.drop();
  await vi.waitFor(() => expect(f.voice.read().status).toBe('failed'));
  expect(f.voice.read().wake.status).toBe('armed');
  f.voice.frame(Buffer.alloc(640).toString('base64'));
  expect(wake.frame).toHaveBeenCalledTimes(1);
  expect(f.audio).toHaveLength(0);
  expect(f.start).not.toHaveBeenCalled();
  await f.voice.command({ action: 'disconnect' });
  await f.voice.command({ action: 'retry-connection' });
  expect(f.voice.read()).toMatchObject({ status: 'disconnected', wake: { status: 'armed' } });
  expect(connectionPrefs.read().enabled).toBe(false);
  expect(prefs.read().enabled).toBe(true);
  await f.voice.command({ action: 'stop-session' });
  expect(prefs.read().enabled).toBe(false);
  expect(f.voice.read().wake.status).toBe('off');
});

it('coalesces simultaneous startup connection requests without closing the owned socket', async () => {
  const f = await create(
    'pcm',
    true,
    undefined,
    undefined,
    undefined,
    'granted',
    new WakePreferences(null),
  );
  await Promise.all([f.voice.startAutoConnection(), f.voice.startAutoConnection()]);
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect(f.connections()).toBe(1);
  expect(f.audio).toHaveLength(0);
});
it('closes capture and service even when saving the wake off choice fails', async () => {
  const prefs = new WakePreferences(null),
    connection = new WakePreferences(null);
  const f = await create('pcm', true, wakePeer(), undefined, prefs, 'granted', connection);
  await f.voice.startAutoConnection();
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'arm-wake', keyword: '丽塔同学', automatic: true });
  vi.spyOn(prefs, 'save').mockImplementation(() => {
    throw new Error('unwritable');
  });
  await expect(f.voice.command({ action: 'stop-session' })).rejects.toThrow();
  expect(f.voice.read()).toMatchObject({
    status: 'disconnected',
    wake: { status: 'off' },
    wakeAutoSuspended: true,
    connectionPreference: { enabled: false },
  });
  await f.voice.startAutoConnection();
  expect(f.connections()).toBe(1);
});

it('detects an unresponsive connection through missing pongs and clears heartbeat retries on exit', async () => {
  const f = await create(
    'pcm',
    true,
    undefined,
    undefined,
    undefined,
    'granted',
    new WakePreferences(null),
  );
  vi.useFakeTimers();
  await f.voice.startAutoConnection();
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  f.ignorePongs();
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.voice.read()).toMatchObject({
    status: 'failed',
    error: '语音服务保活响应超时。',
    connection: { attempt: 1 },
  });
  expect(f.voice.diagnostics().events).toContainEqual(
    expect.objectContaining({
      kind: 'service-failed',
      source: 'heartbeat',
      reason: 'keepalive_timeout',
      explicitClose: false,
    }),
  );
  expect(f.audio).toHaveLength(0);
  f.voice.close();
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.connections()).toBe(1);
});
it.each(['disconnected', 'armed', 'conversation', 'retrying'] as const)(
  'closes %s voice state once without leaving wake, lease, heartbeat or retry timers',
  async (state) => {
    const wake = wakePeer(),
      closed = vi.fn();
    wake.close = closed;
    const f = await create(
      'pcm',
      true,
      wake,
      undefined,
      new WakePreferences(null),
      'granted',
      new WakePreferences(null),
    );
    vi.useFakeTimers();
    if (state !== 'disconnected') {
      await f.voice.startAutoConnection();
      await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
    }
    if (state === 'armed')
      await f.voice.command({ action: 'arm-wake', keyword: '丽塔同学', automatic: true });
    if (state === 'conversation') await f.voice.command({ action: 'start-session' });
    if (state === 'retrying') {
      f.drop();
      await vi.waitFor(() => expect(f.voice.read().connection.nextRetryAt).not.toBeNull());
    }
    const prior = f.connections();
    const closing = f.voice.close();
    expect(f.voice.close()).toBe(closing);
    await closing;
    await vi.advanceTimersByTimeAsync(120000);
    await f.voice.startAutoConnection(true);
    await expect(f.voice.command({ action: 'connect' })).rejects.toThrow('voice_closed');
    expect(f.connections()).toBe(prior);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.voice.read()).toMatchObject({
      status: 'disconnected',
      conversationActive: false,
      wake: { status: 'off' },
    });
  },
);
it('traces actual status calls and results separately from discovery without saving content', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'listen' });
  f.send({ type: 'stt', text: 'PRIVATE_TRANSCRIPT' });
  await vi.waitFor(() => expect(f.voice.read().draft).toBe('PRIVATE_TRANSCRIPT'));
  await f.call(1401, 'workbench_status');
  expect(f.voice.read().handoff).toMatchObject({ status: 'handled', taskId: null });
  const events = f.voice.diagnostics().events;
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'tool-called', tool: 'workbench_status' }),
      expect.objectContaining({ kind: 'tool-returned', tool: 'workbench_status' }),
    ]),
  );
  expect(JSON.stringify(f.voice.diagnostics())).not.toMatch(/PRIVATE_TRANSCRIPT|PRIVATE_TOKEN/);
  expect(f.voice.readConversation().turns[0]?.messages[0]?.text).toBe('PRIVATE_TRANSCRIPT');
  expect(f.start).not.toHaveBeenCalled();
});
it('keeps multiple voice turns when only tools are discovered and no submit tool is called', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  f.send({ type: 'mcp', payload: { jsonrpc: '2.0', id: 1402, method: 'tools/list' } });
  await vi.waitFor(() => expect(f.voice.read().deviceToolsReady).toBe(true));
  for (const text of ['第一轮', '第二轮']) {
    await f.voice.command({ action: 'listen' });
    f.send({ type: 'stt', text });
    f.send({ type: 'tts', state: 'start' });
    f.send({ type: 'tts', state: 'sentence_start', text: '只是语音回复' });
    f.send({ type: 'tts', state: 'stop' });
    await vi.waitFor(() => expect(f.voice.read().handoff?.status).toBe('unhandled'));
  }
  expect(f.voice.readConversation().turns).toHaveLength(2);
  expect(f.voice.diagnostics().events.some((event) => event.kind === 'tool-called')).toBe(false);
  expect(f.voice.diagnostics().events.some((event) => event.kind === 'handoff-missing')).toBe(true);
  expect(f.start).not.toHaveBeenCalled();
});
it('traces rejected submission and permits projectless chat without pretending to create a task', async () => {
  const f = await create('pcm', false);
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  f.state({ project: null });
  await f.voice.command({ action: 'listen' });
  f.send({ type: 'stt', text: '你好' });
  await vi.waitFor(() => expect(f.voice.read().draft).toBe('你好'));
  await f.call(1403, 'workbench_submit', { text: 'PRIVATE_PROMPT' });
  expect(f.voice.diagnostics().events).toContainEqual(
    expect.objectContaining({
      kind: 'tool-rejected',
      tool: 'workbench_submit',
      code: 'voice_submit_disabled',
    }),
  );
  expect(f.voice.readConversation().turns[0]).toMatchObject({
    projectId: null,
    handoff: { status: 'blocked' },
  });
  expect(JSON.stringify(f.voice.diagnostics())).not.toContain('PRIVATE_PROMPT');
  expect(f.start).not.toHaveBeenCalled();
});
it('associates a submit receipt and runner outcome, and retains session text through a reconnect', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'listen' });
  f.send({ type: 'stt', text: '只读检查' });
  await vi.waitFor(() => expect(f.voice.read().draft).toBe('只读检查'));
  const id = f.voice.read().captureId as string,
    projectId = f.voice.diagnostics().events.find((event) => event.kind === 'capture-started')!
      .projectId as string;
  const task = {
    id,
    projectId,
    conversationId: randomUUID(),
    threadId: 'codex-thread-external',
    status: 'starting',
    prompt: '只读检查',
  } as Task;
  f.start.mockReturnValueOnce(task);
  await f.call(1404, 'workbench_submit', { text: '只读检查' });
  f.state({ task: { ...task, status: 'completed' } });
  expect(f.voice.diagnostics().events).toContainEqual(
    expect.objectContaining({ kind: 'task-submitted', taskId: id }),
  );
  expect(f.voice.diagnostics().events).toContainEqual(
    expect.objectContaining({ kind: 'task-status', taskId: id, status: 'completed' }),
  );
  expect(f.voice.readConversation().turns[0]).toMatchObject({
    conversationId: task.conversationId,
    taskStatus: 'completed',
    handoff: { taskId: id },
  });
  await f.voice.command({ action: 'disconnect' });
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect(f.voice.readConversation().turns[0]?.messages[0]?.text).toBe('只读检查');
  f.voice.clearConversation();
  expect(f.voice.readConversation().turns).toEqual([]);
});

it('reports missing handoff after a spoken reply even when the provider never supplies STT', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'listen' });
  f.send({ type: 'tts', state: 'start' });
  f.send({ type: 'tts', state: 'sentence_start', text: '口头答复' });
  f.send({ type: 'tts', state: 'stop' });
  await vi.waitFor(() => expect(f.voice.read().handoff?.status).toBe('unhandled'));
  expect(f.voice.read().draft).toBe('');
  expect(f.voice.readConversation().turns[0]?.messages[0]).toMatchObject({
    role: 'assistant',
    text: '口头答复',
    state: 'final',
  });
  expect(f.voice.diagnostics().events).toContainEqual(
    expect.objectContaining({ kind: 'handoff-missing', code: 'no_tool_call' }),
  );
  expect(f.start).not.toHaveBeenCalled();
});

it('distinguishes a peer close after TTS from idle capture, and reconnects without an old capture identity', async () => {
  const f = await create(
    'pcm',
    true,
    undefined,
    undefined,
    undefined,
    'granted',
    new WakePreferences(null),
  );
  await f.voice.startAutoConnection();
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'listen' });
  const capture = f.voice.read().captureId;
  f.send({ type: 'tts', state: 'start' });
  f.send({ type: 'tts', state: 'stop' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect(f.voice.read().conversationActive).toBe(true);
  expect(f.voice.diagnostics().events.some((event) => event.kind === 'service-failed')).toBe(false);
  vi.useFakeTimers();
  f.remoteClose(1000, 'idle timeout token=PRIVATE_TOKEN');
  await vi.waitFor(() => expect(f.voice.read().status).toBe('failed'));
  expect(f.voice.read()).toMatchObject({ captureId: null, conversationActive: false });
  expect(f.voice.diagnostics().events).toContainEqual(
    expect.objectContaining({
      kind: 'service-failed',
      source: 'websocket',
      reason: 'transport_close',
      closeCode: 1000,
      explicitClose: false,
      captureId: capture,
    }),
  );
  expect(f.voice.diagnostics().events).toContainEqual(
    expect.objectContaining({
      kind: 'service-retry-scheduled',
      retryAttempt: 1,
      retryDelayMs: 1000,
      captureId: null,
    }),
  );
  const detailedClose = f.voice.readDebug().events.find((event) => event.event === 'close');
  expect(detailedClose?.payload).toContain('idle timeout');
  expect(detailedClose?.payload).not.toContain('PRIVATE_TOKEN');
  await vi.advanceTimersByTimeAsync(1000);
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  const latest = f.voice
    .diagnostics()
    .events.filter((event) => event.kind === 'service-ready')
    .at(-1);
  expect(latest?.captureId).toBeNull();
  expect(f.voice.read().conversationActive).toBe(false);
  await f.voice.command({ action: 'disconnect' });
  expect(f.voice.diagnostics().events).toContainEqual(
    expect.objectContaining({
      kind: 'service-disconnected',
      source: 'operator',
      reason: 'manual_disconnect',
      explicitClose: true,
    }),
  );
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.connections()).toBe(2);
  expect(f.start).not.toHaveBeenCalled();
});

it('always records redacted protocol bodies, including before opening diagnostics, and continues after clear', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'listen' });
  f.send({ type: 'stt', text: 'before debug' });
  await vi.waitFor(() => expect(f.voice.read().draft).toBe('before debug'));
  expect(f.voice.readDebug().enabled).toBe(true);
  expect(JSON.stringify(f.voice.readDebug())).toContain('before debug');
  f.voice.debugAction({ action: 'clear' });
  await f.voice.command({ action: 'listen' });
  f.send({
    type: 'stt',
    text: '把标题变粉色',
    provider_extra: { token: 'UNRELATED_PROVIDER_SECRET' },
  });
  f.send({ type: 'tts', state: 'start' });
  f.send({ type: 'tts', state: 'sentence_start', text: '收到，交给 Codex' });
  f.send({ type: 'tts', state: 'stop' });
  await vi.waitFor(() => expect(f.voice.read().draft).toBe('把标题变粉色'));
  await f.call(1601, 'workbench_status');
  await f.call(1602, 'workbench_submit', { text: '把标题变粉色' });
  const detailed = JSON.stringify(f.voice.readDebug());
  expect(detailed).toContain('把标题变粉色');
  expect(detailed).toContain('收到，交给 Codex');
  expect(detailed).toContain('arguments');
  expect(detailed).toContain('result');
  expect(detailed).not.toMatch(
    /PRIVATE_TOKEN|UNRELATED_PROVIDER_SECRET|02:12:34:56:78:90|before debug/,
  );
  expect(JSON.stringify(f.voice.diagnostics())).not.toMatch(/把标题变粉色|收到，交给/);
  f.voice.debugAction({ action: 'clear' });
  expect(f.voice.readDebug().events).toEqual([]);
  await f.call(1603, 'workbench_status');
  expect(f.voice.readDebug().enabled).toBe(true);
  expect(f.voice.readDebug().events.length).toBeGreaterThan(0);
});

it('defaults a new binding on, preserves a stored false during rebinding, and enforces it after reconnection', async () => {
  const fresh = await create();
  const binding = { ...fresh.config()!, allowVoiceSubmit: true };
  fresh.removeConfiguration();
  await fresh.voice.saveBinding(binding);
  expect(fresh.config()?.allowVoiceSubmit).toBe(true);
  const off = await create('pcm', false);
  await off.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(off.voice.read().status).toBe('ready'));
  await off.voice.saveBinding({ ...binding, token: 'NEW_FIXTURE_TOKEN' });
  await vi.waitFor(() => expect(off.voice.read().status).toBe('ready'));
  expect(off.config()?.allowVoiceSubmit).toBe(false);
  expect(off.voice.read().allowVoiceSubmit).toBe(false);
  await off.voice.command({ action: 'listen' });
  expect((await off.call(1604, 'workbench_submit', { text: 'must remain disabled' })).isError).toBe(
    true,
  );
  expect(off.start).not.toHaveBeenCalled();
});

it('retires an idle remote goodbye immediately, clears playback and retains local wake without replaying the capture', async () => {
  const wake = wakePeer();
  const f = await create(
    'pcm',
    true,
    wake,
    undefined,
    undefined,
    'granted',
    new WakePreferences(null),
  );
  await f.voice.startAutoConnection();
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'arm-wake', keyword: '丽塔同学', automatic: true });
  await f.voice.command({ action: 'listen' });
  const captureId = f.voice.read().captureId;
  await f.voice.command({ action: 'stop-listening' });
  f.send({ type: 'stt', text: '看看页面' });
  await f.call(1700, 'workbench_status');
  f.send({ type: 'tts', state: 'start' });
  f.send({ type: 'tts', state: 'sentence_start', text: '普通回复' });
  f.sendBinary(Buffer.alloc(640));
  await vi.waitFor(() =>
    expect(f.native.some((call) => (call.params as { pcm?: string })?.pcm)).toBe(true),
  );
  f.send({ type: 'tts', state: 'stop' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await vi.waitFor(() =>
    expect(f.frames).toContainEqual(expect.objectContaining({ state: 'start' })),
  );
  const nativeBefore = f.native.length,
    framesBefore = f.frames.length,
    audioBefore = f.audio.length;
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 31000);
  f.voice.frame(Buffer.alloc(640).toString('base64'));
  wake.frame.mockClear();
  f.send({ type: 'goodbye' });
  // Queue farewell messages before the peer observes our close, including PCM.
  f.send({ type: 'tts', state: 'start' });
  f.send({ type: 'tts', state: 'sentence_start', text: '后会有期' });
  f.sendBinary(Buffer.alloc(640));
  f.send({ type: 'tts', state: 'stop' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('failed'));
  expect(f.voice.read()).toMatchObject({
    captureId: null,
    conversationActive: false,
    wake: { status: 'armed' },
    wakeAutoSuspended: false,
    connection: { attempt: 1 },
  });
  expect(f.native.slice(nativeBefore)).toEqual([
    { method: 'voice-audio', params: { reset: true } },
  ]);
  expect(f.frames).toHaveLength(framesBefore); // No fake user abort or keepalive utterance.
  expect(f.voice.readConversation().turns.flatMap((turn) => turn.messages)).toContainEqual(
    expect.objectContaining({ text: '普通回复', state: 'final' }),
  );
  expect(
    f.voice
      .readConversation()
      .turns.some((turn) => turn.messages.some((message) => message.text.includes('后会有期'))),
  ).toBe(false);
  f.voice.frame(Buffer.alloc(640).toString('base64'));
  expect(wake.frame).toHaveBeenCalledTimes(1);
  expect(f.audio).toHaveLength(audioBefore);
  await expect(f.voice.command({ action: 'listen' })).rejects.toThrow('voice_not_ready');
  expect(f.voice.diagnostics().events).toContainEqual(
    expect.objectContaining({
      kind: 'service-ending',
      reason: 'remote_goodbye',
      code: 'remote_session_end',
    }),
  );
  expect(f.voice.diagnostics().events.some((event) => event.kind === 'handoff-missing')).toBe(
    false,
  );
  expect(f.connections()).toBe(1);
  expect(f.voice.diagnostics().events).toContainEqual(
    expect.objectContaining({
      kind: 'service-failed',
      source: 'app',
      reason: 'remote_goodbye',
      code: 'remote_session_end',
      remoteGoodbye: true,
      explicitClose: false,
    }),
  );
  expect(f.voice.diagnostics().events.filter((event) => event.closeCode !== undefined)).toEqual([]);
  expect(f.voice.readDebug().events).toContainEqual(
    expect.objectContaining({
      direction: 'local',
      event: 'close',
      payload: expect.stringContaining('remote_goodbye'),
    }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  expect(f.voice.read()).toMatchObject({
    remoteSessionEnding: false,
    captureId: null,
    conversationActive: false,
  });
  expect(f.connections()).toBe(2);
  expect(f.frames.filter((frame) => (frame as { state?: string }).state === 'start')).toHaveLength(
    1,
  );
  expect(f.start).not.toHaveBeenCalled();
  await f.voice.command({ action: 'listen' });
  expect(f.voice.read().captureId).not.toBe(captureId);
  await f.call(1701, 'workbench_submit', { text: '本次新要求' });
  expect(f.start).toHaveBeenCalledTimes(1);
});

it.each(['disconnect', 'stop-session', 'close'] as const)(
  'cancels remote-goodbye recovery on explicit %s and never enables an idle microphone',
  async (action) => {
    const f = await create();
    vi.useFakeTimers();
    await f.voice.command({ action: 'connect' });
    await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
    f.send({ type: 'goodbye', session_id: 'other-session' });
    await vi.waitFor(() =>
      expect(
        f.voice
          .readDebug()
          .events.some(
            (event) => event.direction === 'inbound' && event.payload.includes('goodbye'),
          ),
      ).toBe(true),
    );
    expect(f.voice.read().status).toBe('ready');
    f.send({ type: 'goodbye' });
    await vi.waitFor(() => expect(f.voice.read().connection.attempt).toBe(1));
    expect(f.voice.read()).toMatchObject({ wake: { status: 'off' }, conversationActive: false });
    if (action === 'close') await f.voice.close();
    else await f.voice.command({ action });
    await vi.advanceTimersByTimeAsync(120000);
    await f.voice.startAutoConnection();
    expect(f.connections()).toBe(1);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.audio).toHaveLength(0);
    expect(f.native.every((call) => call.method !== 'microphone-status')).toBe(true);
  },
);

it.each([false, true])(
  'preserves a fresh user reply on goodbye (reply already playing: %s)',
  async (playing) => {
    const f = await create();
    await f.voice.command({ action: 'connect' });
    await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
    await f.voice.command({ action: 'listen' });
    f.send({ type: 'stt', text: '今天先聊到这里' });
    await vi.waitFor(() => expect(f.voice.read().draft).toBe('今天先聊到这里'));
    if (playing) {
      f.send({ type: 'tts', state: 'start' });
      f.send({ type: 'tts', state: 'sentence_start', text: '好的' });
      await vi.waitFor(() => expect(f.voice.read().status).toBe('speaking'));
    }
    f.send({ type: 'goodbye' });
    await vi.waitFor(() => expect(f.voice.read().remoteSessionEnding).toBe(true));
    await expect(f.voice.command({ action: 'listen' })).rejects.toThrow('voice_session_ending');
    if (!playing) f.send({ type: 'tts', state: 'start' });
    f.send({ type: 'tts', state: 'sentence_start', text: '下次见' });
    f.sendBinary(Buffer.alloc(640));
    f.send({ type: 'tts', state: 'stop' });
    await vi.waitFor(() =>
      expect(f.native.some((call) => (call.params as { pcm?: string })?.pcm)).toBe(true),
    );
    await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
    expect(f.voice.readConversation().turns.flatMap((turn) => turn.messages)).toContainEqual(
      expect.objectContaining({ text: playing ? '好的\n下次见' : '下次见', state: 'final' }),
    );
    expect(f.voice.diagnostics().events.some((event) => event.kind === 'handoff-missing')).toBe(
      false,
    );
    expect(f.connections()).toBe(1);
    f.remoteClose(1000, 'session ended');
    await vi.waitFor(() => expect(f.voice.read().status).toBe('failed'));
    expect(f.voice.diagnostics().events).toContainEqual(
      expect.objectContaining({
        kind: 'service-failed',
        source: 'websocket',
        reason: 'transport_close',
        closeCode: 1000,
        remoteGoodbye: true,
        code: 'remote_session_end',
        explicitClose: false,
      }),
    );
    await f.voice.command({ action: 'stop-session' });
    expect(f.voice.read()).toMatchObject({
      status: 'disconnected',
      connectionPreference: { enabled: false },
    });
    expect(f.start).not.toHaveBeenCalled();
  },
);

it('bounds repeated remote goodbyes rather than reconnecting in an endless fast loop', async () => {
  const f = await create();
  vi.useFakeTimers();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000]) {
    f.send({ type: 'goodbye' });
    await vi.waitFor(() => expect(f.voice.read().status).toBe('failed'));
    await vi.advanceTimersByTimeAsync(delay);
    await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  }
  f.send({ type: 'goodbye' });
  await vi.waitFor(() => expect(f.voice.read().connection.exhausted).toBe(true));
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.connections()).toBe(7);
  expect(f.frames.every((frame) => (frame as { type: string }).type === 'hello')).toBe(true);
  expect(f.audio).toHaveLength(0);
});

it('does not accuse a local status broadcast of missing a development tool after capture was closed', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'listen' });
  await f.voice.command({ action: 'disconnect' });
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'speak', text: '已连接' });
  f.send({ type: 'tts', state: 'start' });
  f.send({ type: 'tts', state: 'sentence_start', text: '已连接' });
  f.send({ type: 'tts', state: 'stop' });
  await vi.waitFor(() =>
    expect(
      f.voice
        .readConversation()
        .turns.some(
          (turn) =>
            turn.captureId === null && turn.messages.some((message) => message.text === '已连接'),
        ),
    ).toBe(true),
  );
  expect(f.voice.diagnostics().events.some((event) => event.kind === 'handoff-missing')).toBe(
    false,
  );
  expect(f.start).not.toHaveBeenCalled();
});

it('preserves actual tool request and result payloads through noisy tool-list handshakes', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.call(1900, 'workbench_status');
  for (let id = 2000; id < 2120; id++)
    f.send({ type: 'mcp', payload: { jsonrpc: '2.0', id, method: 'tools/list' } });
  await vi.waitFor(() =>
    expect(
      f.frames.some((value) => (value as { payload?: { id?: number } }).payload?.id === 2119),
    ).toBe(true),
  );
  const log = f.voice.readDebug();
  expect(log.dropped).toBeGreaterThan(0);
  expect(log.droppedImportant).toBe(0);
  expect(log.events).toContainEqual(
    expect.objectContaining({
      direction: 'inbound',
      priority: 'important',
      payload: expect.stringContaining('workbench_status'),
    }),
  );
  expect(log.events).toContainEqual(
    expect.objectContaining({
      direction: 'outbound',
      priority: 'important',
      payload: expect.stringContaining('voiceSubmitEnabled'),
    }),
  );
  expect(log.events.length).toBeLessThanOrEqual(256);
});

it('retains a linked task failure reason after voice disconnect without inventing model execution', async () => {
  const f = await create();
  await f.voice.command({ action: 'connect' });
  await vi.waitFor(() => expect(f.voice.read().status).toBe('ready'));
  await f.voice.command({ action: 'listen' });
  const task = {
    id: f.voice.read().captureId,
    projectId: f.voice.diagnostics().events.find((event) => event.kind === 'capture-started')
      ?.projectId,
    conversationId: randomUUID(),
    threadId: 'codex-thread',
    turnId: null,
    status: 'starting',
    error: null,
  } as Task;
  f.start.mockReturnValueOnce(task);
  await f.call(2190, 'workbench_submit', { text: '检查入口' });
  await f.voice.command({ action: 'disconnect' });
  f.state({
    task: {
      ...task,
      status: 'failed',
      error: 'Codex 未确认所选执行设置，未提交模型任务。',
      activity: '准备失败',
    },
  });
  const failure = f.voice
    .readDebug()
    .events.find((event) => event.taskId === task.id && event.payload.includes('task-failure'));
  expect(failure?.priority).toBe('important');
  expect(failure?.payload).toContain('未提交模型任务');
  expect(failure?.payload).toContain('"turnStarted": false');
  expect(JSON.stringify(f.voice.diagnostics())).not.toContain('未提交模型任务');
});
