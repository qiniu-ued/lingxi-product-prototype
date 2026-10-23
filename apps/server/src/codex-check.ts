import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { CodexCheck } from '@lingxi/protocol';
import { z } from 'zod';

const executeFile = promisify(execFile);
const accountSchema = z.object({
  account: z.union([z.null(), z.object({ type: z.string() })]),
  requiresOpenaiAuth: z.boolean(),
});
type Account = z.infer<typeof accountSchema>;
type AccountResult = { status: 'ok'; account: Account } | { status: 'failed' | 'timed-out' };

function readAccount(executable: string, prefix: string[], timeoutMs: number) {
  return new Promise<AccountResult>((resolve) => {
    const child = spawn(executable, [...prefix, 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let outcome: AccountResult | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: AccountResult) => {
      if (outcome) return;
      outcome = result;
      clearTimeout(deadline);
      child.stdin.end();
      child.kill('SIGTERM');
      force = setTimeout(() => child.kill('SIGKILL'), 500);
    };
    const deadline = setTimeout(() => finish({ status: 'timed-out' }), timeoutMs);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    let buffer = '';
    let bytes = 0;
    let initialized = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (outcome) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) return finish({ status: 'failed' });
      buffer += chunk;
      let boundary = buffer.indexOf('\n');
      while (boundary !== -1 && !outcome) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        try {
          const message = z
            .object({
              id: z.union([z.number(), z.string()]).optional(),
              result: z.unknown().optional(),
              error: z.unknown().optional(),
            })
            .parse(JSON.parse(line));
          if (message.id === 0 && !initialized) {
            if (message.error || !message.result) return finish({ status: 'failed' });
            initialized = true;
            send({ method: 'initialized', params: {} });
            send({ id: 1, method: 'account/read', params: { refreshToken: false } });
          } else if (message.id === 1 && initialized) {
            const account = accountSchema.safeParse(message.result);
            finish(
              account.success && !message.error
                ? { status: 'ok', account: account.data }
                : { status: 'failed' },
            );
          }
        } catch {
          finish({ status: 'failed' });
        }
        boundary = buffer.indexOf('\n');
      }
    });
    // Diagnostics must never return provider errors, credentials or account details.
    child.stderr.resume();
    child.stdin.on('error', () => finish({ status: 'failed' }));
    child.once('error', () => finish({ status: 'failed' }));
    child.once('close', () => {
      clearTimeout(deadline);
      clearTimeout(force);
      resolve(outcome ?? { status: 'failed' });
    });
    send({
      id: 0,
      method: 'initialize',
      params: { clientInfo: { name: 'lingxi_setup', title: '灵矽连接检查', version: '0.1.0' } },
    });
  });
}

// Read-only diagnostics: never create threads, start turns or read credential files.
export async function checkCodex(
  options: { executable?: string; prefixArgs?: string[]; timeoutMs?: number } = {},
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
  const result = await readAccount(executable, prefix, timeoutMs);
  if (result.status !== 'ok') return { ...base, cliVersion: version, status: result.status };
  const account = result.account.account;
  const signedOut = account === null && result.account.requiresOpenaiAuth;
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
