import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { CodexClient } from './codex-client.js';

const clients: CodexClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
function create(executable = process.execPath) {
  const client = new CodexClient({
    executable,
    prefixArgs: [
      fileURLToPath(new URL('../../../tests/fixtures/codex-task.mjs', import.meta.url)),
      'rich',
    ],
    cwd: '/tmp',
    timeoutMs: 300,
    onMessage() {},
    onDisconnect() {},
  });
  clients.push(client);
  return client;
}
it('multiplexes out-of-order responses and isolates request errors/timeouts from the connection', async () => {
  const client = create();
  await client.ready;
  const slow = client.request('fixture/out-of-order', { delay: 40, value: 'slow' });
  const fast = client.request('fixture/out-of-order', { delay: 1, value: 'fast' });
  expect(await fast).toMatchObject({ value: 'fast' });
  expect(await slow).toMatchObject({ value: 'slow' });
  await expect(client.request('fixture/error', {})).rejects.toThrow('codex_request_failed');
  await expect(client.request('fixture/hang', {}, 20)).rejects.toThrow('codex_request_timeout');
  expect(await client.request('model/list', {})).toHaveProperty('data');
});
it.each(['fixture/invalid', 'fixture/exit'])(
  'rejects pending requests on %s and cannot send after closure',
  async (method) => {
    const client = create();
    await client.ready;
    await expect(client.request(method, {})).rejects.toThrow('codex_disconnected');
    await expect(client.request('model/list', {})).rejects.toThrow('codex_disconnected');
  },
);
it('handles an unavailable executable without leaving a pending initialization', async () => {
  const client = create('/tmp/lingxi-nonexistent-codex');
  await expect(client.ready).rejects.toThrow('codex_disconnected');
});
