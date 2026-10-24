import { expect, it, vi } from 'vitest';
import { IpcDesktopBridge } from './desktop-bridge.js';

it('correlates private IPC replies, rejects errors and clears pending work on close', async () => {
  let sent: unknown;
  const original = process.send;
  process.send = ((message: unknown) => {
    sent = message;
    return true;
  }) as NonNullable<typeof process.send>;
  const bridge = new IpcDesktopBridge();
  try {
    const pending = bridge.call('preview');
    const id = (sent as { id: string }).id;
    process.emit('message', { channel: 'other', id });
    process.emit('message', { channel: 'desktop.reply', id: 'unknown' });
    process.emit('message', { channel: 'desktop.reply', id, result: { ok: true } });
    expect(await pending).toEqual({ ok: true });
    const failure = bridge.call('publish');
    const assertion = expect(failure).rejects.toThrow('desktop_operation_failed');
    process.emit('message', {
      channel: 'desktop.reply',
      id: (sent as { id: string }).id,
      error: true,
    });
    await assertion;
    const closed = bridge.call('preview');
    const expected = expect(closed).rejects.toThrow('desktop_closed');
    bridge.close();
    await expected;
  } finally {
    bridge.close();
    if (original) process.send = original;
    else delete process.send;
  }
});
it('bounds a missing desktop response', async () => {
  vi.useFakeTimers();
  const bridge = new IpcDesktopBridge();
  const pending = bridge.call('preview');
  const expected = expect(pending).rejects.toThrow('desktop_timeout');
  await vi.advanceTimersByTimeAsync(15000);
  await expected;
  bridge.close();
  vi.useRealTimers();
});
