import { afterEach, expect, it, vi } from 'vitest';
import { redactVoicePayload, VoiceDebug } from './voice-debug.js';

const base = {
  direction: 'inbound' as const,
  event: 'message' as const,
  sessionId: null,
  captureId: null,
  projectId: null,
  conversationId: null,
  taskId: null,
};
afterEach(() => vi.useRealTimers());

it('retains useful nested protocol content while removing credentials and embedded secret strings', () => {
  const value = redactVoicePayload(
    {
      type: 'mcp',
      payload: {
        method: 'tools/call',
        params: {
          name: 'workbench_submit',
          arguments: {
            text: '把标题变粉色',
            password: 'PASSWORD_VALUE',
            nested: [{ api_key: 'API_VALUE' }],
            result: JSON.stringify({
              answer: '正在处理',
              token: 'NESTED_VALUE',
              headers: { Authorization: 'Bearer AUTH_VALUE', Cookie: 'session=COOKIE_VALUE' },
            }),
            message:
              'password="INLINE_VALUE" api_key=QUERY_VALUE device_id=DEVICE_VALUE; 02:12:34:56:78:90',
            known: 'provider-value-123',
            encoded: encodeURIComponent('provider/value/123'),
            url: 'https://user:URL_VALUE@example.com?token=URL_TOKEN',
            jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef123',
            key: 'sk-testKey123456789',
            natural: 'my password is NATURAL_SECRET; 密码是中文秘密',
          },
        },
      },
    },
    ['provider-value-123', 'provider/value/123'],
  );
  expect(value.payload).toContain('把标题变粉色');
  expect(value.payload).toContain('workbench_submit');
  expect(value.payload).toContain('正在处理');
  expect(value.payload).not.toMatch(
    /PASSWORD_VALUE|API_VALUE|NESTED_VALUE|AUTH_VALUE|COOKIE_VALUE|INLINE_VALUE|QUERY_VALUE|DEVICE_VALUE|02:12|provider-value|provider%2F|URL_VALUE|URL_TOKEN|eyJhb|sk-test|NATURAL_SECRET|中文秘密/,
  );
  expect(value.payload).toContain('[REDACTED]');
  expect(typeof JSON.parse(value.payload).payload.params.arguments.result).toBe('string');
  expect(value.truncated).toBe(false);
});
it('redacts before truncation and bounds arrays, depth, binary data and circular input', () => {
  const input: Record<string, unknown> = {
    text: `${'x'.repeat(4020)}password=BOUNDARY_SECRET ${'y'.repeat(4000)}`,
    audio: new Uint8Array([1, 2]),
    list: Array.from({ length: 80 }, (_, index) => ({ index })),
  };
  input.circular = input;
  const result = redactVoicePayload(input, []);
  expect(result.payload.length).toBeLessThanOrEqual(8192);
  expect(result.payload).not.toContain('BOUNDARY_SECRET');
  expect(result.payload).toContain('[BINARY OMITTED]');
  expect(result.truncated).toBe(true);
  expect(redactVoicePayload('x'.repeat(262145), []).payload).toContain('[TRUNCATED]');
  let deep: unknown = { password: 'DEEP_SECRET' };
  for (let index = 0; index < 15; index++) deep = { nested: deep };
  expect(redactVoicePayload(deep, []).payload).not.toContain('DEEP_SECRET');
  const wide = redactVoicePayload(
    Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`field${i}`, 'x'.repeat(5000)])),
    [],
  );
  expect(wide.payload.length).toBeLessThanOrEqual(8192);
  expect(wide.truncated).toBe(true);
  expect(redactVoicePayload('\ud800', ['\ud800']).payload).toContain('[REDACTED]');
});
it('is opt-in, cannot recover old bodies, rotates without timers and clears on disable or exit', () => {
  vi.useFakeTimers();
  const journal = new VoiceDebug(() => ['PRIVATE_TOKEN']);
  journal.record({ ...base, payload: { text: 'before enabled' } });
  expect(journal.read()).toMatchObject({ enabled: false, events: [] });
  journal.setEnabled(true);
  for (let index = 0; index < 70; index++)
    journal.record({ ...base, payload: { text: `turn ${index}`, token: 'PRIVATE_TOKEN' } });
  expect(journal.read()).toMatchObject({ capacity: 64, dropped: 6 });
  expect(journal.read().events).toHaveLength(64);
  expect(JSON.stringify(journal.read())).not.toMatch(/PRIVATE_TOKEN|before enabled/);
  const copy = journal.read();
  copy.events[0]!.payload = 'mutated';
  expect(journal.read().events[0]?.payload).not.toBe('mutated');
  vi.advanceTimersByTime(11 * 60_000);
  expect(journal.read().events).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  journal.record({ ...base, payload: { text: 'clear me' } });
  journal.clear();
  expect(journal.read().events).toEqual([]);
  journal.record({ ...base, payload: { text: 'stop me' } });
  journal.setEnabled(false);
  journal.record({ ...base, payload: { text: 'not recorded' } });
  expect(journal.read().events).toEqual([]);
  journal.setEnabled(true);
  journal.record({ ...base, payload: { text: 'exit me' } });
  journal.close();
  expect(journal.read()).toMatchObject({ enabled: false, events: [] });
});
