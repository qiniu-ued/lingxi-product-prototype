import { spawn } from 'node:child_process';
import { z } from 'zod';

type Message = {
  id?: number | string | undefined;
  method?: string | undefined;
  result?: unknown;
  params?: unknown;
  error?: unknown;
};
type Sender = (message: unknown) => void;
export type SessionResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'failed' | 'timed-out' | 'cancelled' };

// Only application-defined messages can enter this transport; it is not an HTTP RPC proxy.
export function runCodexSession<T>(options: {
  executable: string;
  prefixArgs?: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  onReady: (send: Sender) => void;
  onMessage: (message: Message, send: Sender, finish: (value: T) => void) => void;
  onCancel?: (send: Sender) => void;
}): Promise<SessionResult<T>> {
  return new Promise((resolve) => {
    const child = spawn(options.executable, [...(options.prefixArgs ?? []), 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let outcome: SessionResult<T> | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = (result: SessionResult<T>) => {
      if (outcome) return;
      outcome = result;
      clearTimeout(deadline);
      child.stdin.end();
      child.kill('SIGTERM');
      force = setTimeout(() => child.kill('SIGKILL'), 500);
    };
    const deadline = setTimeout(() => stop({ status: 'timed-out' }), options.timeoutMs);
    const send: Sender = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const cancel = () => {
      if (outcome) return;
      options.onCancel?.(send);
      stop({ status: 'cancelled' });
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    let buffer = '';
    let bytes = 0;
    let initialized = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (outcome) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) return stop({ status: 'failed' });
      buffer += chunk;
      let boundary = buffer.indexOf('\n');
      while (boundary !== -1 && !outcome) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        try {
          const message = z
            .object({
              id: z.union([z.number(), z.string()]).optional(),
              method: z.string().optional(),
              result: z.unknown().optional(),
              params: z.unknown().optional(),
              error: z.unknown().optional(),
            })
            .parse(JSON.parse(line));
          if (message.error) return stop({ status: 'failed' });
          if (message.id === 0 && !initialized) {
            if (!message.result) return stop({ status: 'failed' });
            initialized = true;
            send({ method: 'initialized', params: {} });
            options.onReady(send);
          } else if (initialized) {
            options.onMessage(message, send, (value) => stop({ status: 'ok', value }));
          }
        } catch {
          stop({ status: 'failed' });
        }
        boundary = buffer.indexOf('\n');
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => stop({ status: 'failed' }));
    child.once('error', () => stop({ status: 'failed' }));
    child.once('close', () => {
      clearTimeout(deadline);
      clearTimeout(force);
      options.signal?.removeEventListener('abort', cancel);
      resolve(outcome ?? { status: 'failed' });
    });
    if (options.signal?.aborted) cancel();
    else
      send({
        id: 0,
        method: 'initialize',
        params: {
          clientInfo: { name: 'lingxi_setup', title: '灵矽连接配置', version: '0.1.0' },
        },
      });
  });
}
