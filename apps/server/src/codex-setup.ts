import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CODEX_SETUP_PACKAGE,
  type CodexSetupAction,
  type CodexSetupRequest,
  codexAuthorizationUrlSchema,
} from '@lingxi/protocol';
import { z } from 'zod';
import { checkCodex } from './codex-check.js';
import { runCodexSession } from './codex-session.js';

const pointerSchema = z.strictObject({ directory: z.string().regex(/^codex-[0-9a-f-]{36}$/) });
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
class SetupFailure extends Error {
  constructor(readonly code: NonNullable<CodexSetupAction['error']>) {
    super(code);
  }
}

// Fixed local operations only. Never accept shell text, arguments or paths from HTTP.
export class CodexSetup {
  private action: CodexSetupAction | null = null;
  private history = new Map<string, CodexSetupAction>();
  private controller: AbortController | undefined;
  private pending: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly options: {
      toolsRoot: string;
      executable?: string;
      prefixArgs?: string[];
      npmExecutable?: string;
      npmPrefixArgs?: string[];
      installTimeoutMs?: number;
      loginTimeoutMs?: number;
    },
  ) {}

  snapshot() {
    return { action: this.action };
  }
  private update(patch: Partial<CodexSetupAction>) {
    if (!this.action) return;
    this.action = { ...this.action, ...patch, updatedAt: new Date().toISOString() };
    this.history.set(this.action.id, this.action);
  }
  private async executable() {
    if (this.options.executable) return this.options.executable;
    try {
      const pointer = pointerSchema.parse(
        JSON.parse(await readFile(join(this.options.toolsRoot, 'codex-current.json'), 'utf8')),
      );
      return join(this.options.toolsRoot, pointer.directory, 'node_modules/.bin/codex');
    } catch {
      return 'codex';
    }
  }
  async check(signal?: AbortSignal) {
    return checkCodex({
      executable: await this.executable(),
      prefixArgs: this.options.prefixArgs ?? [],
      ...(signal ? { signal } : {}),
    });
  }
  start(request: CodexSetupRequest) {
    const prior = this.history.get(request.requestId);
    if (prior) return { conflict: prior.kind !== request.kind, action: prior };
    if (this.closed || (this.action && !terminal.has(this.action.state)))
      return { conflict: true, action: this.action };
    this.action = {
      id: request.requestId,
      kind: request.kind,
      state: request.kind === 'install' ? 'installing' : 'starting-login',
      error: null,
      authUrl: null,
      check: null,
      updatedAt: new Date().toISOString(),
    };
    this.history.set(request.requestId, this.action);
    if (this.history.size > 20) this.history.delete(this.history.keys().next().value as string);
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.run(request.kind, controller.signal);
    return { conflict: false, action: this.action };
  }
  cancel(id: string) {
    if (!this.action || this.action.id !== id) return false;
    if (!terminal.has(this.action.state)) {
      this.update({ state: 'cancelling', authUrl: null });
      this.controller?.abort();
    }
    return true;
  }
  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.pending;
  }
  private async run(kind: CodexSetupRequest['kind'], signal: AbortSignal) {
    try {
      if (kind === 'install') await this.install(signal);
      else await this.login(signal);
      if (signal.aborted) throw new Error('cancelled');
      this.update({ state: 'succeeded', authUrl: null });
    } catch (error) {
      this.update({
        state: signal.aborted ? 'cancelled' : 'failed',
        authUrl: null,
        error: signal.aborted
          ? null
          : error instanceof SetupFailure
            ? error.code
            : kind === 'install'
              ? 'install_failed'
              : 'login_failed',
      });
    }
  }
  private async install(signal: AbortSignal) {
    if (this.options.executable) throw new SetupFailure('custom_path_configured');
    const directory = `codex-${randomUUID()}`;
    const stage = join(this.options.toolsRoot, directory);
    const pointerTemp = join(this.options.toolsRoot, `${directory}.json`);
    let activated = false;
    try {
      await mkdir(stage, { recursive: true });
      await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true }));
      const status = await this.installPackage(stage, signal);
      if (status === 'timed-out') throw new SetupFailure('timed_out');
      if (status !== 'ok' || signal.aborted) throw new SetupFailure('install_failed');
      this.update({ state: 'checking' });
      const check = await checkCodex({
        executable: join(stage, 'node_modules/.bin/codex'),
        signal,
      });
      this.update({ check });
      if (!['ready', 'signed-out'].includes(check.status) || signal.aborted)
        throw new SetupFailure('verification_failed');
      await writeFile(pointerTemp, JSON.stringify({ directory }));
      if (signal.aborted) throw new Error('cancelled');
      await rename(pointerTemp, join(this.options.toolsRoot, 'codex-current.json'));
      activated = true;
    } finally {
      await rm(pointerTemp, { force: true });
      if (!activated) await rm(stage, { recursive: true, force: true });
    }
  }
  private installPackage(
    stage: string,
    signal: AbortSignal,
  ): Promise<'ok' | 'failed' | 'timed-out'> {
    return new Promise((resolve) => {
      const child = spawn(
        this.options.npmExecutable ?? 'npm',
        [
          ...(this.options.npmPrefixArgs ?? []),
          'install',
          '--prefix',
          stage,
          '--save-exact',
          '--no-audit',
          '--no-fund',
          CODEX_SETUP_PACKAGE,
        ],
        { stdio: 'ignore', shell: false, detached: process.platform !== 'win32' },
      );
      let outcome: 'failed' | 'timed-out' | undefined;
      let force: ReturnType<typeof setTimeout> | undefined;
      const kill = (sig: NodeJS.Signals) => {
        if (child.pid && process.platform !== 'win32') {
          try {
            process.kill(-child.pid, sig);
          } catch {
            /* The process group already exited. */
          }
        } else child.kill(sig);
      };
      const stop = (status: 'failed' | 'timed-out') => {
        if (outcome) return;
        outcome = status;
        kill('SIGTERM');
        force = setTimeout(() => kill('SIGKILL'), 500);
      };
      const abort = () => stop('failed');
      const deadline = setTimeout(
        () => stop('timed-out'),
        this.options.installTimeoutMs ?? 180_000,
      );
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', () => stop('failed'));
      child.once('close', (code) => {
        clearTimeout(deadline);
        // Kill any installer descendants before reporting cancellation complete.
        if (outcome) kill('SIGKILL');
        clearTimeout(force);
        signal.removeEventListener('abort', abort);
        resolve(outcome ?? (code === 0 ? 'ok' : 'failed'));
      });
      if (signal.aborted) abort();
    });
  }
  private async login(signal: AbortSignal) {
    let loginId: string | undefined;
    const responseSchema = z.object({
      type: z.literal('chatgpt'),
      loginId: z.string(),
      authUrl: codexAuthorizationUrlSchema,
    });
    const completedSchema = z.object({ loginId: z.string(), success: z.boolean() });
    const result = await runCodexSession<boolean>({
      executable: await this.executable(),
      prefixArgs: this.options.prefixArgs ?? [],
      timeoutMs: this.options.loginTimeoutMs ?? 600_000,
      signal,
      onReady: (send) =>
        send({ id: 1, method: 'account/login/start', params: { type: 'chatgpt' } }),
      onMessage: (message, _send, finish) => {
        if (message.id === 1) {
          const response = responseSchema.parse(message.result);
          loginId = response.loginId;
          this.update({ state: 'waiting-for-login', authUrl: response.authUrl });
        } else if (message.method === 'account/login/completed') {
          const completed = completedSchema.parse(message.params);
          if (completed.loginId === loginId) finish(completed.success);
        }
      },
      onCancel: (send) => {
        if (loginId) send({ id: 2, method: 'account/login/cancel', params: { loginId } });
      },
    });
    if (result.status === 'timed-out') throw new SetupFailure('timed_out');
    if (result.status !== 'ok' || !result.value || signal.aborted)
      throw new SetupFailure('login_failed');
    this.update({ state: 'checking', authUrl: null });
    const check = await this.check(signal);
    this.update({ check });
    if (check.status !== 'ready' || check.authentication !== 'chatgpt')
      throw new SetupFailure('verification_failed');
  }
}
