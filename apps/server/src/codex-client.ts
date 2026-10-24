import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { z } from 'zod';

export type RpcMessage = {
  id?: string | number | undefined;
  method?: string | undefined;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};
const wireSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

// One connection owns all threads and PTYs for the selected project. Provider
// errors reject only their request; transport loss never replays a request.
export class CodexClient {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private stopped = false;
  private threadSettings = new Map<string, unknown>();
  private settingsWaiters = new Map<
    string,
    {
      accept: (value: unknown) => boolean;
      resolve: (value: boolean) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private force: ReturnType<typeof setTimeout> | undefined;
  private buffer = '';
  private exited: Promise<void>;
  readonly ready: Promise<void>;
  constructor(
    private options: {
      executable: string;
      prefixArgs?: string[];
      cwd: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      onMessage: (message: RpcMessage) => void;
      onDisconnect: () => void;
    },
  ) {
    this.child = spawn(options.executable, [...(options.prefixArgs ?? []), 'app-server'], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.resume(); // Never echo provider output or account secrets to UI/logs.
    this.child.stdin.on('error', () => this.disconnect());
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    this.child.on('error', () => this.disconnect());
    this.exited = new Promise((resolve) =>
      this.child.on('close', () => {
        this.disconnect();
        clearTimeout(this.force);
        resolve();
      }),
    );
    this.ready = this.request('initialize', {
      clientInfo: { name: 'lingxi-workbench', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    }).then(() => {
      this.send({ method: 'initialized' });
    });
  }
  request(
    method: string,
    params: unknown,
    timeoutMs: number | null = this.options.timeoutMs ?? 15000,
  ): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error('codex_disconnected'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const entry: {
        resolve: typeof resolve;
        reject: typeof reject;
        timer?: ReturnType<typeof setTimeout>;
      } = { resolve, reject };
      if (timeoutMs !== null)
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('codex_request_timeout'));
        }, timeoutMs);
      this.pending.set(id, entry);
      this.send({ id, method, params });
    });
  }
  respond(id: string | number, result: unknown) {
    this.send({ id, result });
  }
  async updateSettings(
    params: { threadId: string; [key: string]: unknown },
    accept: (value: unknown) => boolean,
  ) {
    if (this.settingsWaiters.has(params.threadId)) throw new Error('settings_busy');
    const confirmed = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), this.options.timeoutMs ?? 15000);
      this.settingsWaiters.set(params.threadId, { accept, resolve, timer });
    });
    try {
      await this.request('thread/settings/update', params);
      // Codex omits the notification for a no-op. Recheck the latest server
      // snapshot after the acknowledgement; requested settings are not evidence.
      if (
        !accept(this.threadSettings.get(params.threadId)) &&
        (!(await confirmed) || !accept(this.threadSettings.get(params.threadId)))
      )
        throw new Error('execution_unconfirmed');
    } catch (error) {
      this.threadSettings.delete(params.threadId);
      throw error;
    } finally {
      const waiter = this.settingsWaiters.get(params.threadId);
      clearTimeout(waiter?.timer);
      this.settingsWaiters.delete(params.threadId);
    }
  }
  reject(id: string | number) {
    this.send({ id, error: { code: -32601, message: 'Unsupported operation' } });
  }
  private send(message: RpcMessage) {
    if (!this.stopped) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private receive(chunk: string) {
    this.buffer += chunk;
    // Bound individual frames, not cumulative output of a long-lived session.
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.disconnect();
      return;
    }
    let end = this.buffer.indexOf('\n');
    while (end >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      end = this.buffer.indexOf('\n');
      if (!line.trim()) continue;
      try {
        const message = wireSchema.parse(JSON.parse(line));
        if (!message.method && typeof message.id === 'number') {
          const entry = this.pending.get(message.id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(message.id);
            if (message.error) entry.reject(new Error('codex_request_failed'));
            else entry.resolve(message.result);
          }
        } else {
          if (message.method === 'thread/settings/updated') {
            const event = z
              .object({ threadId: z.string(), threadSettings: z.unknown() })
              .safeParse(message.params);
            if (event.success) {
              this.threadSettings.set(event.data.threadId, event.data.threadSettings);
              const waiter = this.settingsWaiters.get(event.data.threadId);
              if (waiter?.accept(event.data.threadSettings)) waiter.resolve(true);
            }
          }
          this.options.onMessage(message);
        }
      } catch {
        this.disconnect();
        return;
      }
    }
  }
  private disconnect() {
    if (this.stopped) return;
    this.stopped = true;
    this.threadSettings.clear();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('codex_disconnected'));
    }
    this.pending.clear();
    for (const waiter of this.settingsWaiters.values()) waiter.resolve(false);
    this.kill('SIGTERM');
    this.force = setTimeout(() => this.kill('SIGKILL'), 500);
    this.options.onDisconnect();
  }
  private kill(signal: NodeJS.Signals) {
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch {
      /* Already exited. */
    }
  }
  async close() {
    this.disconnect();
    await this.exited;
  }
}
