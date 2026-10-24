import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { voiceConfigSchema, voiceStateSchema } from './voice.js';

it('defaults missing voice execution and startup preferences on without overriding saved false', () => {
  const config = {
    endpoint: 'wss://xrobo-io.qiniuapi.com/v1/ws/',
    deviceId: '02:12:34:56:78:90',
    clientId: randomUUID(),
    token: 'FIXTURE_TOKEN',
  };
  expect(voiceConfigSchema.parse(config).allowVoiceSubmit).toBe(true);
  expect(voiceConfigSchema.parse({ ...config, allowVoiceSubmit: false }).allowVoiceSubmit).toBe(
    false,
  );
  expect(voiceConfigSchema.safeParse({ ...config, allowVoiceSubmit: null }).success).toBe(false);
  const base = {
    configured: false,
    status: 'disconnected',
    draft: '',
    captureId: null,
    subtitle: '',
    error: null,
  };
  const state = voiceStateSchema.parse(base);
  expect(state.allowVoiceSubmit).toBe(true);
  expect(state.wakePreference).toEqual({ version: 1, enabled: true, source: 'default' });
  expect(state.connectionPreference.enabled).toBe(true);
  const off = { version: 1, enabled: false, source: 'user' };
  expect(
    voiceStateSchema.parse({
      ...base,
      allowVoiceSubmit: false,
      wakePreference: off,
      connectionPreference: off,
    }),
  ).toMatchObject({ allowVoiceSubmit: false, wakePreference: off, connectionPreference: off });
});
