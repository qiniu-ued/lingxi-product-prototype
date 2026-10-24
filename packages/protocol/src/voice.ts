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
  contextDetailsOpen: z.boolean().default(false),
  wake: z
    .strictObject({
      status: z.enum(['off', 'installing', 'loading', 'armed', 'detected', 'failed']),
      keyword: z.string(),
      installed: z.boolean(),
      detectionId: z.uuid().nullable(),
      error: z.string().nullable(),
    })
    .default({
      status: 'off',
      keyword: '丽塔同学',
      installed: false,
      detectionId: null,
      error: null,
    }),
});
export const wakeKeywordSchema = z
  .string()
  .trim()
  .regex(/^[\u4e00-\u9fff]{2,12}$/);
export const voiceCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('connect') }),
  z.strictObject({ action: z.literal('disconnect') }),
  z.strictObject({ action: z.literal('listen') }),
  z.strictObject({ action: z.literal('stop-listening') }),
  z.strictObject({ action: z.literal('stop-speaking') }),
  z.strictObject({ action: z.literal('speak'), text: z.string().min(1).max(1000) }),
  z.strictObject({ action: z.literal('install-wake') }),
  z.strictObject({ action: z.literal('arm-wake'), keyword: wakeKeywordSchema }),
  z.strictObject({ action: z.literal('stop-wake') }),
  z.strictObject({ action: z.literal('context-details'), open: z.boolean() }),
]);
export type VoiceState = z.infer<typeof voiceStateSchema>;
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;
export type VoiceCommand = z.infer<typeof voiceCommandSchema>;
