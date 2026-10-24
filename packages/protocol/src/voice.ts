import { z } from 'zod';

export const voiceConfigSchema = z.strictObject({
  endpoint: z.literal('wss://xrobo-io.qiniuapi.com/v1/ws/'),
  deviceId: z.string().regex(/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/),
  clientId: z.uuid(),
  token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\r\n]+$/),
  allowVoiceSubmit: z.boolean().default(false),
});
export const voiceStateSchema = z.strictObject({
  configured: z.boolean(),
  status: z.enum(['disconnected', 'connecting', 'ready', 'listening', 'speaking', 'failed']),
  draft: z.string(),
  captureId: z.uuid().nullable(),
  subtitle: z.string(),
  error: z.string().nullable(),
  allowVoiceSubmit: z.boolean(),
});
export const voiceCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('connect') }),
  z.strictObject({ action: z.literal('disconnect') }),
  z.strictObject({ action: z.literal('listen') }),
  z.strictObject({ action: z.literal('stop-listening') }),
  z.strictObject({ action: z.literal('stop-speaking') }),
  z.strictObject({ action: z.literal('speak'), text: z.string().min(1).max(1000) }),
]);
export type VoiceState = z.infer<typeof voiceStateSchema>;
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;
export type VoiceCommand = z.infer<typeof voiceCommandSchema>;
