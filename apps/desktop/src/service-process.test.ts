import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { ServiceProcess } from './service-process.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null as number | null,
    signalCode: null as string | null,
    killed: false,
    send: vi.fn((_message: unknown, callback: (error: Error | null) => void) => {
      callback(null);
      return true;
    }),
    kill: vi.fn((_signal: string) => true),
  });
  const failure = vi.fn();
  const service = new ServiceProcess(child as unknown as ChildProcess, failure);
  const exit = () => {
    child.exitCode = 0;
    child.emit('exit', 0);
  };
  return { child, failure, service, exit };
}
it('stops new work, sends one shutdown and shares one completion for repeated exit requests', async () => {
  vi.useFakeTimers();
  const f = fixture();
  expect(f.service.send({ channel: 'desktop.audio' })).toBe(true);
  const stopped = f.service.stop();
  expect(f.service.stop()).toBe(stopped);
  expect(f.service.send({ channel: 'desktop.voice-resume' })).toBe(false);
  expect(f.child.send).toHaveBeenCalledTimes(2);
  f.exit();
  await stopped;
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['throw', 'callback'] as const)(
  'owns a %s channel-close race and reports it during normal operation',
  async (mode) => {
    const f = fixture();
    const error = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
    f.child.send.mockImplementation((_message, callback) => {
      if (mode === 'throw') throw error;
      queueMicrotask(() => callback(error));
      return false;
    });
    f.service.send({ channel: 'desktop.preview' });
    await Promise.resolve();
    expect(f.failure).toHaveBeenCalledWith(error);
    const stopped = f.service.stop();
    await Promise.resolve();
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
    f.exit();
    await stopped;
    expect(f.failure).toHaveBeenCalledTimes(1);
  },
);
it('terminates an already disconnected child, forces an unresponsive child, and bounds the exit wait', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.child.connected = false;
  expect(f.service.send({})).toBe(false);
  const stopped = expect(f.service.stop(100)).rejects.toThrow('service_exit_timeout');
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
  await vi.advanceTimersByTimeAsync(100);
  expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
  await vi.advanceTimersByTimeAsync(1000);
  await stopped;
  expect(vi.getTimerCount()).toBe(0);
  expect(f.child.listenerCount('exit')).toBe(0);
  const finished = fixture();
  finished.exit();
  await finished.service.stop();
  expect(finished.child.send).not.toHaveBeenCalled();
});
it('retains unexpected shutdown errors while suppressing only expected channel-close races', async () => {
  const f = fixture();
  const stopped = f.service.stop();
  f.child.emit('error', Object.assign(new Error('closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' }));
  const error = Object.assign(new Error('unexpected'), { code: 'EACCES' });
  f.child.emit('error', error);
  expect(f.failure).toHaveBeenCalledExactlyOnceWith(error);
  f.exit();
  await stopped;
});
