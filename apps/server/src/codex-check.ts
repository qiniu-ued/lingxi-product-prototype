import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CodexCheck } from '@lingxi/protocol';
import { z } from 'zod';
import { runCodexSession } from './codex-session.js';

const executeFile = promisify(execFile);
const accountSchema = z.object({
  account: z.union([z.null(), z.object({ type: z.string() })]),
  requiresOpenaiAuth: z.boolean(),
});
type Account = z.infer<typeof accountSchema>;

// Read-only diagnostics: never create threads, start turns or read credential files.
export async function checkCodex(
  options: {
    executable?: string;
    prefixArgs?: string[];
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<CodexCheck> {
  const executable = options.executable ?? process.env.LINGXI_CODEX_BIN ?? 'codex';
  const prefix = options.prefixArgs ?? [];
  const timeoutMs = options.timeoutMs ?? 8000;
  const base = { checkedAt: new Date().toISOString(), cliVersion: null, authentication: null };
  let version: string;
  try {
    const result = await executeFile(executable, [...prefix, '--version'], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024,
      encoding: 'utf8',
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const match = result.stdout.trim().match(/^codex(?:-cli)? (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/);
    if (!match?.[1]) return { ...base, status: 'failed' };
    version = match[1];
  } catch (error) {
    const failure = error as { code?: string; killed?: boolean };
    return {
      ...base,
      status: failure.code === 'ENOENT' ? 'not-installed' : failure.killed ? 'timed-out' : 'failed',
    };
  }
  const result = await runCodexSession<Account>({
    executable,
    prefixArgs: prefix,
    timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    onReady: (send) => send({ id: 1, method: 'account/read', params: { refreshToken: false } }),
    onMessage: (message, _send, finish) => {
      if (message.id === 1) finish(accountSchema.parse(message.result));
    },
  });
  if (result.status !== 'ok')
    return {
      ...base,
      cliVersion: version,
      status: result.status === 'cancelled' ? 'failed' : result.status,
    };
  const account = result.value.account;
  const signedOut = account === null && result.value.requiresOpenaiAuth;
  return {
    ...base,
    cliVersion: version,
    status: signedOut ? 'signed-out' : 'ready',
    authentication: signedOut
      ? null
      : account?.type === 'chatgpt'
        ? 'chatgpt'
        : account?.type === 'apiKey'
          ? 'api-key'
          : 'provider',
  };
}
