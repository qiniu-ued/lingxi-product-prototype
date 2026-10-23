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
