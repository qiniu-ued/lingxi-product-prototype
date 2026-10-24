import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';

export interface DesktopBridge {
  call(method: string, params?: unknown): Promise<unknown>;
}
interface IpcEndpoint extends Pick<EventEmitter, 'on' | 'off'> {
  connected?: boolean;
  send?: (message: object, callback: (error: Error | null) => void) => boolean;
}

// Private Node IPC channel owned by the desktop parent; never exposed as an HTTP proxy.
export class IpcDesktopBridge implements DesktopBridge {
  private closed = false;
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
  private disconnected = () => this.close();
  constructor(private endpoint: IpcEndpoint = process) {
    endpoint.on('message', this.receive);
    endpoint.on('disconnect', this.disconnected);
  }
  call(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closed || !this.endpoint.connected || !this.endpoint.send)
      return Promise.reject(new Error('desktop_closed'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const fail = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new Error('desktop_ipc_failed'));
      };
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error('desktop_timeout'));
        },
        method === 'action' ? 120000 : 15000,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        // A callback owns asynchronous channel-close errors, including the race
        // between the connected check and the actual send. false means backpressure.
        this.endpoint.send?.({ channel: 'desktop.request', id, method, params }, (error) => {
          if (error) fail();
        });
      } catch {
        fail();
      }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.endpoint.off('message', this.receive);
    this.endpoint.off('disconnect', this.disconnected);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('desktop_closed'));
    }
    this.pending.clear();
  }
}
