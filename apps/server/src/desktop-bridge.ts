import { randomUUID } from 'node:crypto';

export interface DesktopBridge {
  call(method: string, params?: unknown): Promise<unknown>;
}

// Private Node IPC channel owned by the desktop parent; never exposed as an HTTP proxy.
export class IpcDesktopBridge implements DesktopBridge {
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private receive = (message: unknown) => {
    if (
      !message ||
      typeof message !== 'object' ||
      !('channel' in message) ||
      message.channel !== 'desktop.reply' ||
      !('id' in message) ||
      typeof message.id !== 'string'
    )
      return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if ('error' in message) entry.reject(new Error('desktop_operation_failed'));
    else entry.resolve('result' in message ? message.result : null);
  };
  constructor() {
    process.on('message', this.receive);
  }
  call(method: string, params: unknown = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error('desktop_timeout'));
        },
        method === 'action' ? 120000 : 15000,
      );
      this.pending.set(id, { resolve, reject, timer });
      process.send?.({ channel: 'desktop.request', id, method, params });
    });
  }
  close() {
    process.off('message', this.receive);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('desktop_closed'));
    }
    this.pending.clear();
  }
}
