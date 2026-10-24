import { type VoiceConfig, voiceConfigSchema } from '@lingxi/protocol';
import { z } from 'zod';
import type { DesktopBridge } from './desktop-bridge.js';

export const bindingStateSchema = z.object({
  status: z.enum(['idle', 'requesting', 'waiting', 'checking', 'bound', 'failed', 'cancelled']),
  deviceId: z.string().nullable(),
  clientId: z.uuid().nullable(),
  code: z.string().nullable(),
  error: z.string().nullable(),
});
const identitySchema = z.object({ deviceId: voiceConfigSchema.shape.deviceId, clientId: z.uuid() });
const otaSchema = z.object({
  error: z.unknown().optional(),
  activation: z
    .object({ code: z.string().regex(/^\d{6}$/), challenge: z.string().optional() })
    .optional(),
  websocket: z.object({ url: z.string(), token: z.string().optional() }).optional(),
});
const base = 'https://xrobo.qiniuapi.com/v1/ota/';
async function limitedText(response: Response) {
  if (!response.body) throw new Error('empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return Buffer.concat(chunks).toString('utf8');
      length += part.value.byteLength;
      if (length > 65536) throw new Error('response_too_large');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
}

// The official OTA API is also the device registration/binding gateway. Never
// download or apply the firmware URLs in its response: this is a desktop app.
export class VoiceBinding {
  private state: z.infer<typeof bindingStateSchema> = {
    status: 'idle',
    deviceId: null,
    clientId: null,
    code: null,
    error: null,
  };
  private controller: AbortController | undefined;
  constructor(
    private options: {
      desktop?: DesktopBridge;
      save: (config: VoiceConfig) => Promise<void>;
      fetch?: typeof fetch;
    },
  ) {}
  read() {
    return this.state;
  }
  private update(value: Partial<z.infer<typeof bindingStateSchema>>) {
    this.state = { ...this.state, ...value };
  }
  async inspect() {
    if (!this.options.desktop) throw new Error('desktop_required');
    const identity = identitySchema.parse(await this.options.desktop.call('voice-identity'));
    this.update(identity);
    return identity;
  }
  async action(action: 'start' | 'check' | 'cancel') {
    if (action === 'cancel') {
      this.controller?.abort();
      this.update({ status: 'cancelled', error: null });
      return;
    }
    if (this.controller) throw new Error('binding_busy');
    const controller = new AbortController();
    this.controller = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    try {
      const identity = await this.inspect();
      signal.throwIfAborted();
      this.update({ status: action === 'start' ? 'requesting' : 'checking', error: null });
      if (action === 'check') {
        const response = await (this.options.fetch ?? fetch)(`${base}activate`, {
          method: 'POST',
          headers: { 'Device-Id': identity.deviceId },
          redirect: 'error',
          signal,
        });
        if (response.status === 202) {
          this.update({ status: 'waiting' });
          return;
        }
        if (response.status !== 200 || (await limitedText(response)).trim() !== 'success')
          throw new Error('activation_check_failed');
      }
      const response = await (this.options.fetch ?? fetch)(base, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'Activation-Version': '1',
          'Device-Id': identity.deviceId,
          'Client-Id': identity.clientId,
          'User-Agent': 'lingxi-workbench/0.2.0',
          'Accept-Language': 'zh-CN',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: 0,
          uuid: identity.clientId,
          mac_address: identity.deviceId,
          application: { name: 'lingxi-workbench', version: '0.2.0', elf_sha256: '' },
          board: { type: 'lingxi-macos', ssid: '', rssi: 0 },
        }),
      });
      if (response.status !== 200) throw new Error('ota_failed');
      const result = otaSchema.parse(JSON.parse(await limitedText(response)));
      signal.throwIfAborted();
      if (result.error) throw new Error('ota_rejected');
      if (result.websocket?.token) {
        const url = new URL(result.websocket.url);
        if (
          !['ws:', 'wss:'].includes(url.protocol) ||
          url.hostname !== 'xrobo-io.qiniuapi.com' ||
          url.port ||
          url.username ||
          url.password ||
          url.pathname !== '/v1/ws/' ||
          url.search ||
          url.hash
        )
          throw new Error('unsupported_voice_endpoint');
        // The gateway currently documents ws:// in examples; always upgrade the
        // official host to WSS before sending a credential.
        await this.options.save(
          voiceConfigSchema.parse({
            endpoint: 'wss://xrobo-io.qiniuapi.com/v1/ws/',
            ...identity,
            token: result.websocket.token,
            allowVoiceSubmit: false,
          }),
        );
        signal.throwIfAborted();
        this.update({ status: 'bound', code: null });
      } else if (result.activation) {
        if (
          result.activation.challenge &&
          result.activation.challenge.toLowerCase() !== identity.deviceId.toLowerCase()
        )
          throw new Error('wrong_device');
        this.update({ status: 'waiting', code: result.activation.code });
      } else throw new Error('missing_activation');
    } catch {
      this.update({
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        error: controller.signal.aborted
          ? null
          : '未能完成设备绑定。请检查网络、官方控制台绑定状态后重试；未下载或安装设备固件。',
      });
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
  close() {
    this.controller?.abort();
  }
}
