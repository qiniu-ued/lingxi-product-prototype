import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexCheckSchema, setupInspectionSchema, setupStatusSchema } from '@lingxi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

const apps: ReturnType<typeof buildApp>[] = [];
function create() {
  const app = buildApp({ databasePath: ':memory:' });
  apps.push(app);
  return app;
}
const input = () => ({
  commandId: randomUUID(),
  source: 'keyboard',
  text: '更新标题',
  expectedRevision: 0,
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('local command API', () => {
  it('serves both production views through the local service', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lingxi-static-'));
    writeFileSync(join(directory, 'index.html'), '<!doctype html><title>丽塔同学工作台</title>');
    const app = buildApp({ databasePath: ':memory:', webRoot: directory });
    try {
      for (const url of ['/', '/display', '/setup']) {
        const response = await app.inject(url);
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('丽塔同学工作台');
      }
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('persists suggestions as drafts and reports unconfigured integrations honestly', async () => {
    const app = create();
    const response = await app.inject({ method: 'POST', url: '/api/commands', payload: input() });
    expect(response.statusCode).toBe(201);
    expect(response.json().commands[0].status).toBe('draft');
    expect(response.json().integrations).toEqual({
      codex: 'not-configured',
      lingxi: 'not-configured',
    });
    expect((await app.inject('/api/session')).json()).toEqual(response.json());
  });
  it('returns a successful retry without duplicating a command', async () => {
    const app = create();
    const payload = input();
    await app.inject({ method: 'POST', url: '/api/commands', payload });
    const retry = await app.inject({ method: 'POST', url: '/api/commands', payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().commands).toHaveLength(1);
  });
  it('streams durable snapshots, catches up on reconnect and closes subscribers on shutdown', async () => {
    const app = create();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const connect = async () => {
      const controller = new AbortController();
      const response = await fetch(`${address}/api/events`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      });
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing event stream');
      const decoder = new TextDecoder();
      let pending = '';
      return {
        controller,
        reader,
        async snapshot() {
          while (!pending.includes('\n\n')) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('Stream ended before snapshot');
            pending += decoder.decode(chunk.value, { stream: true });
          }
          const boundary = pending.indexOf('\n\n');
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          expect(frame).toContain('event: session.snapshot');
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (!data) throw new Error('Missing snapshot data');
          return JSON.parse(data.slice(6));
        },
      };
    };
    const stream = await connect();
    try {
      expect((await stream.snapshot()).revision).toBe(0);
      const saved = await app.inject({ method: 'POST', url: '/api/commands', payload: input() });
      expect(await stream.snapshot()).toEqual(saved.json());
      stream.controller.abort();
      const reconnected = await connect();
      try {
        expect(await reconnected.snapshot()).toEqual(saved.json());
        await app.close();
        expect((await reconnected.reader.read()).done).toBe(true);
      } finally {
        reconnected.controller.abort();
      }
    } finally {
      stream.controller.abort();
    }
  });
  it('returns useful errors for malformed and conflicting submissions', async () => {
    const app = create();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/commands',
          payload: { ...input(), text: ' ' },
        })
      ).statusCode,
    ).toBe(400);
    await app.inject({ method: 'POST', url: '/api/commands', payload: input() });
    const stale = await app.inject({ method: 'POST', url: '/api/commands', payload: input() });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('revision_conflict');
  });
  it('rejects foreign websites and DNS-rebinding hosts', async () => {
    const app = create();
    for (const headers of [{ origin: 'https://example.com' }, { host: 'attacker.example:4310' }]) {
      expect(
        (await app.inject({ method: 'POST', url: '/api/commands', headers, payload: input() }))
          .statusCode,
      ).toBe(403);
    }
  });
  it('exposes a health endpoint without requiring provider credentials', async () => {
    expect((await create().inject('/api/health')).json()).toEqual({
      status: 'ok',
      schemaVersion: 1,
    });
  });
  it('reports the service host and unfinished capabilities without probing Codex on page load', async () => {
    const checkCodex = vi.fn();
    const app = buildApp({ databasePath: ':memory:', checkCodex });
    apps.push(app);
    const response = await app.inject('/api/setup');
    const setup = setupStatusSchema.parse(response.json());
    expect(setup.host).toMatchObject({ platform: process.platform, arch: process.arch });
    expect(setup.capabilities).toEqual({ codexTasks: false, lingxiVoice: false });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(checkCodex).not.toHaveBeenCalled();
  });
  it('keeps diagnostics separate from saved session state and rejects executable input', async () => {
    const check = {
      status: 'ready',
      cliVersion: '0.164.0',
      authentication: 'chatgpt',
      checkedAt: new Date().toISOString(),
    };
    const checkCodex = vi.fn(async () => codexCheckSchema.parse(check));
    const app = buildApp({ databasePath: ':memory:', checkCodex });
    apps.push(app);
    const before = (await app.inject('/api/session')).json();
    for (const request of [
      { payload: { executable: 'arbitrary-command' } },
      { payload: {}, headers: { origin: 'https://attacker.example' } },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/codex/check',
        ...request,
      });
      expect([400, 403]).toContain(response.statusCode);
    }
    expect(checkCodex).not.toHaveBeenCalled();
    const response = await app.inject({
      method: 'POST',
      url: '/api/setup/codex/check',
      payload: {},
    });
    expect(response.json()).toEqual(check);
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await app.inject('/api/session')).json()).toEqual(before);
  });
  it('shares a running diagnostic between simultaneous requests', async () => {
    let release: (() => void) | undefined;
    const checkCodex = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return codexCheckSchema.parse({
        status: 'not-installed',
        cliVersion: null,
        authentication: null,
        checkedAt: new Date().toISOString(),
      });
    });
    const app = buildApp({ databasePath: ':memory:', checkCodex });
    apps.push(app);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/setup/check',
      payload: { executable: 'shell' },
    });
    expect(invalid.statusCode).toBe(400);
    const requests = ['/api/setup/codex/check', '/api/setup/check'].map((url) =>
      app.inject({ method: 'POST', url, payload: {} }).then((response) => response.json()),
    );
    await vi.waitFor(() => expect(checkCodex).toHaveBeenCalledTimes(1));
    release?.();
    const results = await Promise.all(requests);
    const inspection = setupInspectionSchema.parse(results[1]);
    expect(results[0]).toEqual(inspection.codex);
    expect(inspection.lingxi).toMatchObject({
      status: 'unavailable',
      reason: 'desktop-required',
    });
    expect(checkCodex).toHaveBeenCalledTimes(1);
  });
});

describe('desktop voice configuration boundary', () => {
  it('inspects both providers without registering a device, and keeps credentials out of responses', async () => {
    let config: unknown = null;
    const native: string[] = [];
    const app = buildApp({
      databasePath: ':memory:',
      checkCodex: async () => ({
        status: 'not-installed',
        cliVersion: null,
        authentication: null,
        checkedAt: new Date().toISOString(),
      }),
      desktop: {
        async call(method, params) {
          native.push(method);
          if (method === 'voice-config-read') return config;
          if (method === 'voice-config-save') config = params;
          return null;
        },
      },
    });
    apps.push(app);
    const post = (url: string, payload: unknown, origin = 'http://localhost:80') =>
      app.inject({ method: 'POST', url, headers: { origin }, payload: JSON.stringify(payload) });
    // Explicit JSON content type is also part of the boundary.
    const json = (url: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url,
        headers: { origin: 'http://localhost:80', 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
    const check = await json('/api/setup/check', {});
    expect(check.json().lingxi.status).toBe('not-configured');
    expect(native).toEqual(['voice-config-read', 'microphone-status']);
    expect(check.json().wake.status).toBe('not-installed');
    expect((await json('/api/voice/config', { token: 'bad' })).statusCode).toBe(400);
    expect((await json('/api/voice/command', { action: 'listen' })).statusCode).toBe(409);
    expect((await post('/api/voice/config', {})).statusCode).toBe(415);
    const saved = await json('/api/voice/config', {
      endpoint: 'wss://xrobo-io.qiniuapi.com/v1/ws/',
      deviceId: '02:12:34:56:78:90',
      clientId: 'b328db8c-5dfa-4389-9035-3cd43b2868d2',
      token: 'PRIVATE_VOICE_TOKEN',
      allowVoiceSubmit: false,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('PRIVATE_VOICE_TOKEN');
    expect((await app.inject('/api/voice')).json().configured).toBe(true);
    expect((await json('/api/voice/inspect', {})).json().configured).toBe(true);
    expect(
      (await json('/api/voice/preferences', { allowVoiceSubmit: true })).json().allowVoiceSubmit,
    ).toBe(true);
    expect((await json('/api/setup/check', {})).json().lingxi.status).toBe('configured');
    expect((await app.inject('/api/voice/binding')).json().status).toBe('idle');
    expect((await json('/api/voice/binding', { action: 'cancel' })).json().status).toBe(
      'cancelled',
    );
    expect((await json('/api/voice/binding', { action: 'arbitrary' })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/voice/command',
          payload: { action: 'disconnect' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await json('/api/voice/command', { action: 'disconnect' })).statusCode).toBe(200);
  });
  it('does not expose desktop configuration or binding mutations in browser-only mode', async () => {
    const app = buildApp({ databasePath: ':memory:' });
    apps.push(app);
    for (const url of ['/api/voice/config', '/api/voice/binding'])
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { origin: 'http://localhost:80' },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
  });
});

it('returns every setup result even when individual diagnostics fail, without starting voice or exposing errors', async () => {
  const native: string[] = [];
  const app = buildApp({
    databasePath: ':memory:',
    checkCodex: async () => {
      throw new Error('PRIVATE_CODEX_ERROR');
    },
    checkWake: async () => {
      throw new Error('PRIVATE_NATIVE_ERROR');
    },
    desktop: {
      async call(method) {
        native.push(method);
        if (method === 'microphone-status') return 'denied';
        throw new Error('PRIVATE_KEYCHAIN_ERROR');
      },
    },
  });
  apps.push(app);
  const response = await app.inject({ method: 'POST', url: '/api/setup/check', payload: {} });
  expect(response.statusCode).toBe(200);
  const result = setupInspectionSchema.parse(response.json());
  expect(result.codex.status).toBe('failed');
  expect(result.lingxi.reason).toBe('secure-storage-unavailable');
  expect(result.wake?.reason).toBe('native-unavailable');
  expect(result.microphone).toBe('denied');
  expect(native).toEqual(['voice-config-read', 'microphone-status']);
  expect(response.body).not.toContain('PRIVATE');
  expect((await app.inject('/api/voice')).json()).toMatchObject({
    status: 'disconnected',
    wake: { status: 'off' },
  });
});

it('defaults missing preferences on even with an existing database, and preserves off across restart without creating bindings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lingxi-default-migration-'));
  const make = () =>
    buildApp({
      databasePath: join(root, 'lingxi.db'),
      desktop: {
        async call() {
          return null;
        },
      },
    });
  let app = make();
  try {
    await app.close();
    expect(existsSync(join(root, 'lingxi.db'))).toBe(true);
    for (const name of ['wake-preferences.v1.json', 'voice-connection-preferences.v1.json'])
      rmSync(join(root, name));
    app = make();
    expect((await app.inject('/api/voice')).json()).toMatchObject({
      allowVoiceSubmit: true,
      wakePreference: { enabled: true, source: 'default' },
      connectionPreference: { enabled: true, source: 'default' },
    });
    for (const action of ['wake-auto', 'connection-auto']) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/voice/command',
            headers: { origin: 'http://localhost:80' },
            payload: { action, enabled: false },
          })
        ).statusCode,
      ).toBe(200);
    }
    await app.close();
    app = make();
    expect((await app.inject('/api/voice')).json()).toMatchObject({
      wakePreference: { enabled: false, source: 'user' },
      connectionPreference: { enabled: false, source: 'user' },
    });
    expect(existsSync(join(root, 'voice-device.json'))).toBe(false);
    expect(existsSync(join(root, 'voice-config.enc'))).toBe(false);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('exposes always-on bounded voice metadata and session chat with guarded clear controls', async () => {
  const app = buildApp({
    databasePath: ':memory:',
    desktop: {
      async call() {
        return null;
      },
    },
  });
  apps.push(app);
  const result = await app.inject('/api/voice/diagnostics');
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    enabled: true,
    capacity: 128,
    events: [],
    snapshot: { projectSelected: false },
  });
  expect(result.headers['cache-control']).toBe('no-store');
  const headers = { origin: 'http://localhost:80' };
  for (const [url, capacity] of [
    ['/api/voice/debug', 64],
    ['/api/voice/diagnostics', 128],
  ] as const) {
    expect((await app.inject(url)).json()).toMatchObject({ enabled: true, capacity, events: [] });
    expect(
      (await app.inject({ method: 'POST', url, payload: { action: 'clear' } })).statusCode,
    ).toBe(403);
    for (const payload of [
      { action: 'enabled', enabled: false },
      { action: 'enabled', enabled: true },
      { action: 'clear', token: 'PRIVATE' },
    ]) {
      expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
      expect((await app.inject(url)).json().enabled).toBe(true);
    }
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: { action: 'clear' } })).json()
        .enabled,
    ).toBe(true);
  }
  const chat = await app.inject('/api/voice/conversation');
  expect(chat.json()).toEqual({ revision: 0, turns: [] });
  expect(
    (
      await app.inject({
        url: '/api/voice/conversation',
        headers: { 'if-none-match': chat.headers.etag as string },
      })
    ).statusCode,
  ).toBe(304);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/voice/conversation',
        headers,
        payload: { action: 'clear' },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/voice/conversation',
        headers,
        payload: { action: 'clear', text: 'PRIVATE' },
      })
    ).statusCode,
  ).toBe(400);
});
