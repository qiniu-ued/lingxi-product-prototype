import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexCheckSchema } from '@lingxi/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCodex } from './codex-check.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function probe(mode: string, timeoutMs = 1500) {
  const directory = await mkdtemp(join(tmpdir(), 'lingxi-codex-check-'));
  temporary.push(directory);
  const record = join(directory, 'messages.jsonl');
  const result = await checkCodex({
    executable: process.execPath,
    prefixArgs: [
      fileURLToPath(new URL('../../../tests/fixtures/codex-cli.mjs', import.meta.url)),
      mode,
      record,
    ],
    timeoutMs,
  });
  return { result, record };
}

describe('read-only Codex environment check', () => {
  it('reports missing installations without invoking a shell', async () => {
    const result = await checkCodex({ executable: '/no-such-lingxi-codex;echo-secret' });
    expect(codexCheckSchema.parse(result).status).toBe('not-installed');
  });
  it.each([
    ['ready', 'ready', 'chatgpt'],
    ['signed-out', 'signed-out', null],
    ['api-key', 'ready', 'api-key'],
    ['provider', 'ready', 'provider'],
  ] as const)(
    'checks %s without creating tasks or exposing credentials',
    async (mode, status, authentication) => {
      const { result, record } = await probe(mode);
      expect(codexCheckSchema.parse(result)).toMatchObject({
        status,
        authentication,
        cliVersion: '0.164.0',
      });
      const records = (await readFile(record, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.filter((entry) => entry.method).map((entry) => entry.method)).toEqual([
        'initialize',
        'initialized',
        'account/read',
      ]);
      expect(records.find((entry) => entry.method === 'account/read').params.refreshToken).toBe(
        false,
      );
      expect(JSON.stringify(result)).not.toMatch(/private@|never-return|email|token/);
      const pid = records[0].pid as number;
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );
  it.each([
    'invalid-version',
    'version-error',
    'bad-json',
    'rpc-error',
    'broken-account',
    'exit',
    'oversized',
  ])('handles %s as a diagnostic failure', async (mode) => {
    const { result } = await probe(mode);
    expect(result.status).toBe('failed');
    expect(result.authentication).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private provider error');
  });
  it.each(['version-hang', 'hang', 'force-kill'])('bounds and cleans up %s', async (mode) => {
    const { result, record } = await probe(mode, 500);
    expect(result.status).toBe('timed-out');
    if (mode !== 'version-hang') {
      const first = JSON.parse((await readFile(record, 'utf8')).split('\n')[0] ?? '{}');
      expect(() => process.kill(first.pid, 0)).toThrow();
    }
  });
});
