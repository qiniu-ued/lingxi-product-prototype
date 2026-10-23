import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexSetupStateSchema } from '@lingxi/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { CodexSetup } from './codex-setup.js';

const fixture = fileURLToPath(new URL('../../../tests/fixtures/codex-setup.mjs', import.meta.url));
const temporary: string[] = [];
const managers: CodexSetup[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup(mode = 'success', kind: 'npm' | 'cli' = 'npm', timeout = 3000) {
  const root = await mkdtemp(join(tmpdir(), 'lingxi-setup-'));
  temporary.push(root);
  const record = join(root, 'messages');
  const manager = new CodexSetup({
    toolsRoot: root,
    ...(kind === 'cli'
      ? { executable: process.execPath, prefixArgs: [fixture, 'cli', mode, record] }
      : { npmExecutable: process.execPath, npmPrefixArgs: [fixture, 'npm', mode, record] }),
    installTimeoutMs: timeout,
    loginTimeoutMs: timeout,
  });
  managers.push(manager);
  return { manager, root, record };
}
async function wait(manager: CodexSetup, state: string) {
  await expect
    .poll(() => manager.snapshot().action?.state, { timeout: 6000, interval: 20 })
    .toBe(state);
  return codexSetupStateSchema.parse(manager.snapshot()).action;
}
const request = (kind: 'install' | 'login') => ({ requestId: randomUUID(), kind });

describe('fixed local Codex configuration operations', () => {
  it('installs latest into managed storage, verifies the actual version, then selects it', async () => {
    const { manager, root, record } = await setup();
    await writeFile(join(root, 'codex-current.json'), '{"directory":"../../outside"}');
    const command = request('install');
    expect(manager.start(command).conflict).toBe(false);
    expect(manager.start(command).action?.id).toBe(command.requestId);
    expect(manager.start({ ...command, kind: 'login' }).conflict).toBe(true);
    expect(manager.start(request('login')).conflict).toBe(true);
    const result = await wait(manager, 'succeeded');
    expect(result?.check).toMatchObject({ status: 'signed-out', cliVersion: '0.999.0' });
    expect(manager.start(command).action?.state).toBe('succeeded');
    const records = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const install = records.find((line) => line.kind === 'npm');
    expect(install.args).toEqual([
      'install',
      '--prefix',
      expect.stringMatching(/codex-/),
      '--save-exact',
      '--no-audit',
      '--no-fund',
      '@openai/codex@latest',
    ]);
    expect(records.filter((line) => line.kind === 'npm')).toHaveLength(1);
    expect((await manager.check()).status).toBe('signed-out');
    expect(JSON.parse(await readFile(join(root, 'codex-current.json'), 'utf8')).directory).toMatch(
      /^codex-/,
    );
    expect(records.filter((line) => line.method).map((line) => line.method)).not.toContain(
      'turn/start',
    );
  });
  it.each([
    ['fail', 'install_failed'],
    ['bad-protocol', 'verification_failed'],
    ['hang', 'timed_out'],
  ])('leaves the previous installation untouched after %s', async (mode, error) => {
    const { manager, root } = await setup(mode, 'npm', 350);
    const previous = '{"directory":"codex-00000000-0000-0000-0000-000000000000"}';
    await writeFile(join(root, 'codex-current.json'), previous);
    manager.start(request('install'));
    const result = await wait(manager, 'failed');
    expect(result?.error).toBe(error);
    expect(await readFile(join(root, 'codex-current.json'), 'utf8')).toBe(previous);
    expect(await readdir(root)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^codex-[a-f0-9-]{36}$/)]),
    );
    expect(JSON.stringify(result)).not.toContain('private installer');
  });
  it('cancels an actual installer and cleans only its own staging directory', async () => {
    const { manager, root, record } = await setup('hang');
    const id = request('install');
    manager.start(id);
    await expect
      .poll(async () => (await readFile(record, 'utf8').catch(() => '')).length)
      .toBeGreaterThan(0);
    const pid = JSON.parse((await readFile(record, 'utf8')).split('\n')[0] ?? '{}').pid;
    expect(manager.cancel(randomUUID())).toBe(false);
    expect(manager.cancel(id.requestId)).toBe(true);
    await wait(manager, 'cancelled');
    expect(manager.cancel(id.requestId)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await readdir(root)).filter((name) => name.startsWith('codex-'))).toEqual([]);
    await manager.close();
    expect(manager.start(request('install')).conflict).toBe(true);
  });
  it('does not install over a custom executable', async () => {
    const { manager } = await setup('success', 'cli');
    manager.start(request('install'));
    expect((await wait(manager, 'failed'))?.error).toBe('custom_path_configured');
  });
  it('performs official login and verifies the resulting account without returning secrets', async () => {
    const { manager, record } = await setup('success', 'cli');
    manager.start(request('login'));
    await wait(manager, 'waiting-for-login');
    expect(manager.snapshot().action?.authUrl).toBe('https://auth.openai.com/authorize?fixture=1');
    const result = await wait(manager, 'succeeded');
    expect(result?.check).toMatchObject({ status: 'ready', authentication: 'chatgpt' });
    expect(result?.authUrl).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private@');
    const messages = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(messages.filter((line) => line.method).map((line) => line.method)).toEqual([
      'initialize',
      'initialized',
      'account/login/start',
      'initialize',
      'initialized',
      'account/read',
    ]);
    for (const line of messages.filter((line) => line.pid))
      expect(() => process.kill(line.pid, 0)).toThrow();
  });
  it.each([
    ['unsafe-url', 'login_failed'],
    ['login-fail', 'login_failed'],
    ['unverified', 'verification_failed'],
    ['hang', 'timed_out'],
  ])('rejects %s login', async (mode, error) => {
    const { manager } = await setup(mode, 'cli', 400);
    manager.start(request('login'));
    expect((await wait(manager, 'failed'))?.error).toBe(error);
    expect(manager.snapshot().action?.authUrl).toBeNull();
  });
  it('stops waiting for OAuth and sends the fixed cancellation message', async () => {
    const { manager, record } = await setup('hang', 'cli');
    const command = request('login');
    manager.start(command);
    await wait(manager, 'waiting-for-login');
    manager.cancel(command.requestId);
    await wait(manager, 'cancelled');
    // The peer may be terminated before reading the cancellation; all children still exit.
    const messages = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const line of messages.filter((line) => line.pid))
      expect(() => process.kill(line.pid, 0)).toThrow();
  });
  it('bounds in-memory retry history', async () => {
    const { manager } = await setup('success', 'cli');
    for (let index = 0; index < 21; index++) {
      manager.start(request('install'));
      await wait(manager, 'failed');
    }
    expect(manager.snapshot().action?.error).toBe('custom_path_configured');
  });
});

describe('configuration HTTP boundaries', () => {
  it('requires a local Origin and strict fixed actions; preserves session state', async () => {
    const { manager } = await setup('hang', 'cli');
    const app = buildApp({ databasePath: ':memory:', codexSetup: manager });
    try {
      const before = (await app.inject('/api/session')).json();
      const local = { origin: 'http://localhost:80' };
      expect((await app.inject('/api/setup/codex/action')).json()).toEqual({ action: null });
      for (const url of ['/api/setup/codex/action', '/api/setup/codex/cancel']) {
        expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(403);
        expect(
          (
            await app.inject({
              method: 'POST',
              url,
              headers: { origin: 'https://foreign.example' },
              payload: {},
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              method: 'POST',
              url,
              headers: local,
              payload: { command: 'echo arbitrary' },
            })
          ).statusCode,
        ).toBe(400);
      }
      const command = request('login');
      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/codex/action',
        headers: local,
        payload: command,
      });
      expect(response.statusCode).toBe(202);
      expect(response.headers['cache-control']).toBe('no-store');
      await wait(manager, 'waiting-for-login');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/setup/codex/action',
            headers: local,
            payload: request('install'),
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/setup/codex/cancel',
            headers: local,
            payload: { id: randomUUID() },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/setup/codex/cancel',
            headers: local,
            payload: { id: command.requestId },
          })
        ).statusCode,
      ).toBe(200);
      await wait(manager, 'cancelled');
      expect((await app.inject('/api/session')).json()).toEqual(before);
    } finally {
      await app.close();
    }
  });
});
