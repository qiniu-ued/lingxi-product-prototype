import type { ChildProcess, Serializable } from 'node:child_process';

const channelClosed = (error: Error) =>
  ['ERR_IPC_CHANNEL_CLOSED', 'ERR_IPC_DISCONNECTED', 'EPIPE'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );

// Own every send callback and one bounded shutdown for the private service child.
export class ServiceProcess {
  private stopping = false;
  private stopped: Promise<void> | undefined;
  constructor(
    readonly child: ChildProcess,
    private failure: (error: Error) => void,
  ) {
    child.on('error', (error) => {
      if (!this.stopping || !channelClosed(error)) failure(error);
    });
  }
  send(message: Serializable) {
    if (this.stopping || !this.child.connected || this.exited() || this.child.killed) return false;
    try {
      return this.child.send(message, (error) => {
        if (error && (!this.stopping || !channelClosed(error))) this.failure(error);
      });
    } catch (error) {
      if (!this.stopping || !channelClosed(error as Error)) this.failure(error as Error);
      return false;
    }
  }
  private exited() {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }
  stop(graceMs = 6000) {
    if (this.stopped) return this.stopped;
    this.stopping = true;
    this.stopped = new Promise<void>((resolve, reject) => {
      if (this.exited()) return resolve();
      const child = this.child;
      const finish = (error?: Error) => {
        clearTimeout(force);
        clearTimeout(deadline);
        child.off('exit', exited);
        child.off('close', exited);
        if (error) reject(error);
        else resolve();
      };
      const exited = () => finish();
      const kill = (signal: NodeJS.Signals) => {
        if (!this.exited()) child.kill(signal);
      };
      const force = setTimeout(() => kill('SIGKILL'), graceMs);
      const deadline = setTimeout(() => finish(new Error('service_exit_timeout')), graceMs + 1000);
      child.once('exit', exited);
      child.once('close', exited);
      if (child.connected) {
        try {
          child.send({ channel: 'desktop.shutdown' }, (error) => {
            if (error) {
              if (!channelClosed(error)) this.failure(error);
              kill('SIGTERM');
            }
          });
        } catch (error) {
          if (!channelClosed(error as Error)) this.failure(error as Error);
          kill('SIGTERM');
        }
      } else kill('SIGTERM');
    });
    return this.stopped;
  }
}
