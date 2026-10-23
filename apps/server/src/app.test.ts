import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    writeFileSync(join(directory, 'index.html'), '<!doctype html><title>灵矽工作台</title>');
    const app = buildApp({ databasePath: ':memory:', webRoot: directory });
    try {
      for (const url of ['/', '/display']) {
        const response = await app.inject(url);
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('灵矽工作台');
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
});
