import { randomUUID } from 'node:crypto';
import {
  type Task,
  type VoiceConfig,
  type WorkbenchState,
  workbenchSchema,
} from '@lingxi/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { VoiceService } from './voice.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function create(format = 'pcm', allowed = true) {
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
  const voice = new VoiceService({
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
