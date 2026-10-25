import { randomUUID } from 'node:crypto';
import { type VoiceConfig, voiceConfigSchema } from '@lingxi/protocol';
import { expect, it, vi } from 'vitest';
import { VoiceBinding } from './voice-binding.js';

const identity = { deviceId: '02:12:34:56:78:90', clientId: randomUUID() };
function create(responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('network');
    return response;
  });
  const save = vi.fn(async (_config: VoiceConfig) => {});
  const binding = new VoiceBinding({
    desktop: {
      async call() {
        return identity;
      },
    },
    save,
    fetch: fetcher,
  });
  return { binding, save, fetcher };
}
it('registers one stable device, displays the six-digit code, checks activation and saves WSS credentials privately', async () => {
  const { binding, save, fetcher } = create([
    Response.json({
      activation: { code: '608303', challenge: identity.deviceId },
      websocket: { url: 'ws://xrobo-io.qiniuapi.com/v1/ws/' },
      firmware: { url: 'https://untrusted.example/firmware' },
    }),
    new Response(null, { status: 202 }),
    new Response('success'),
    Response.json({
      websocket: { url: 'ws://xrobo-io.qiniuapi.com/v1/ws/', token: 'PRIVATE_DEVICE_TOKEN' },
    }),
  ]);
  await binding.action('start');
  expect(binding.read()).toMatchObject({ status: 'waiting', code: '608303', ...identity });
  const [, options] = fetcher.mock.calls[0] ?? [];
  expect(options?.headers).toMatchObject({
    'Activation-Version': '1',
    'Device-Id': identity.deviceId,
    'Client-Id': identity.clientId,
  });
  expect(JSON.parse(options?.body as string)).toMatchObject({
    mac_address: identity.deviceId,
    application: { name: 'lingxi-workbench' },
  });
  await binding.action('check');
  expect(binding.read().status).toBe('waiting');
  await binding.action('check');
  expect(binding.read().status).toBe('bound');
  expect(save).toHaveBeenCalledWith(
    voiceConfigSchema.parse({
      ...identity,
      endpoint: 'wss://xrobo-io.qiniuapi.com/v1/ws/',
      token: 'PRIVATE_DEVICE_TOKEN',
      allowVoiceSubmit: true,
    }),
  );
  expect(JSON.stringify(binding.read())).not.toContain('PRIVATE_DEVICE_TOKEN');
  expect(
    fetcher.mock.calls.every(([url]) =>
      String(url).startsWith('https://xrobo.qiniuapi.com/v1/ota/'),
    ),
  ).toBe(true);
});
it.each([
  Response.json({ error: 'Invalid OTA request with PRIVATE info' }),
  Response.json({ activation: { code: '123456', challenge: 'different-device' } }),
  Response.json({ websocket: { url: 'wss://untrusted.example/', token: 'PRIVATE' } }),
  Response.json({ websocket: { url: 'ws://xrobo-io.qiniuapi.com/v1/ws/' } }),
  Response.json({ activation: { code: '1234' } }),
  new Response('server failure', { status: 500 }),
  new Response('x'.repeat(65537)),
])(
  'fails closed for invalid OTA or endpoint responses without disclosing body details',
  async (response) => {
    const { binding, save } = create([response]);
    await binding.action('start');
    expect(binding.read().status).toBe('failed');
    expect(binding.read().error).not.toContain('PRIVATE');
    expect(save).not.toHaveBeenCalled();
  },
);
it('does not equate HTTP 200 JSON exceptions with successful activation', async () => {
  const { binding, save } = create([Response.json({ code: 500, data: null })]);
  await binding.action('check');
  expect(binding.read().status).toBe('failed');
  expect(save).not.toHaveBeenCalled();
});
it('cancels in-flight registration, bounds retries and never saves cancelled results', async () => {
  let release: (() => void) | undefined;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    init?.signal?.throwIfAborted();
    return Response.json({});
  });
  const save = vi.fn(async () => {});
  const binding = new VoiceBinding({
    desktop: {
      async call() {
        return identity;
      },
    },
    save,
    fetch: fetcher,
  });
  const pending = binding.action('start');
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
  await expect(binding.action('start')).rejects.toThrow('binding_busy');
  await binding.action('cancel');
  release?.();
  await pending;
  expect(binding.read().status).toBe('cancelled');
  expect(save).not.toHaveBeenCalled();
  binding.close();
  await expect(new VoiceBinding({ save }).inspect()).rejects.toThrow('desktop_required');
});
