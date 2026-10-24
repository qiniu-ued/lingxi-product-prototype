import { afterEach, expect, it, vi } from 'vitest';
import { VoiceDiagnostics } from './voice-diagnostics.js';

const entry = {
  kind: 'tools-discovered' as const,
  sessionId: null,
  captureId: null,
  projectId: null,
  conversationId: null,
  taskId: null,
};
afterEach(() => vi.useRealTimers());
it('bounds metadata by age and capacity without a retention timer', () => {
  vi.useFakeTimers();
  const log = new VoiceDiagnostics();
  for (let i = 0; i < 200; i++) log.record(entry);
  expect(log.read()).toMatchObject({ capacity: 128, dropped: 72 });
  expect(log.read().events).toHaveLength(128);
  expect(log.read().events[0]?.sequence).toBe(73);
  vi.advanceTimersByTime(31 * 60_000);
  expect(log.read().events).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it('rejects content-bearing entries, continues after clear, closes terminally and returns isolated reads', () => {
  const log = new VoiceDiagnostics();
  log.record({ ...entry, text: 'PRIVATE_TRANSCRIPT', token: 'PRIVATE_TOKEN' } as typeof entry);
  log.record({ ...entry, tool: 'PRIVATE_TOKEN' } as unknown as typeof entry);
  expect(log.read().events).toHaveLength(0);
  log.record(entry);
  const view = log.read();
  view.events[0]!.kind = 'assistant-start';
  expect(log.read().events[0]?.kind).toBe('tools-discovered');
  log.clear();
  expect(log.read().events).toHaveLength(0);
  log.record(entry);
  expect(log.read()).toMatchObject({ enabled: true });
  expect(log.read().events).toHaveLength(1);
  log.close();
  log.record(entry);
  expect(log.read()).toMatchObject({ enabled: true, events: [] });
});
