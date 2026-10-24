import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { IpcDesktopBridge } from './desktop-bridge.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const endpoint = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn((_message: object, _callback: (error: Error | null) => void) => true),
  });
  const bridge = new IpcDesktopBridge(endpoint);
  return {
    endpoint,
    bridge,
    id: () => (endpoint.send.mock.lastCall?.[0] as { id: string } | undefined)?.id ?? '',
  };
}
it('correlates private replies, rejects operation errors and is terminal on repeated close', async () => {
  const { endpoint, bridge, id } = fixture();
  const pending = bridge.call('preview');
  endpoint.emit('message', { channel: 'other', id: id() });
  endpoint.emit('message', { channel: 'desktop.reply', id: 'unknown' });
  endpoint.emit('message', { channel: 'desktop.reply', id: id(), result: { ok: true } });
  expect(await pending).toEqual({ ok: true });
  const failure = expect(bridge.call('publish')).rejects.toThrow('desktop_operation_failed');
  endpoint.emit('message', { channel: 'desktop.reply', id: id(), error: true });
  await failure;
  const closed = expect(bridge.call('preview')).rejects.toThrow('desktop_closed');
  bridge.close();
  bridge.close();
  await closed;
  await expect(bridge.call('voice-audio')).rejects.toThrow('desktop_closed');
  expect(endpoint.send).toHaveBeenCalledTimes(3);
  expect(endpoint.listenerCount('message') + endpoint.listenerCount('disconnect')).toBe(0);
});
it('bounds a missing desktop response and clears its timer', async () => {
  vi.useFakeTimers();
  const { bridge } = fixture();
  const expected = expect(bridge.call('preview')).rejects.toThrow('desktop_timeout');
  await vi.advanceTimersByTimeAsync(15000);
  await expected;
  bridge.close();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['throw', 'callback'] as const)(
  'rejects a %s send race without a process error or lingering timeout',
  async (mode) => {
    vi.useFakeTimers();
    const { endpoint, bridge } = fixture();
    endpoint.send.mockImplementation((_message, callback) => {
      const error = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
      if (mode === 'throw') throw error;
      queueMicrotask(() => callback(error));
      return false;
    });
    await expect(bridge.call('voice-audio')).rejects.toThrow('desktop_ipc_failed');
    expect(vi.getTimerCount()).toBe(0);
    bridge.close();
  },
);
it('rejects pending requests immediately on disconnect and never sends on a closed channel', async () => {
  vi.useFakeTimers();
  const { endpoint, bridge } = fixture();
  const pending = expect(bridge.call('preview')).rejects.toThrow('desktop_closed');
  endpoint.connected = false;
  endpoint.emit('disconnect');
  await pending;
  await expect(bridge.call('voice-audio')).rejects.toThrow('desktop_closed');
  expect(endpoint.send).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  const absent = new IpcDesktopBridge(Object.assign(new EventEmitter(), { connected: false }));
  await expect(absent.call('preview')).rejects.toThrow('desktop_closed');
  absent.close();
});
