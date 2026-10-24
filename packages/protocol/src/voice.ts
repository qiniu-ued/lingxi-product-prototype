import { z } from 'zod';

export const LINGXI_WORKBENCH_ROLE =
  '你是丽塔同学共创工作台的语音入口，实际开发由本机 Codex 执行。用户说“把这个页面变成粉色”、修改布局、文案或代码时，调用 workbench_submit，text 保留用户的完整修改要求；不需要用户再说“提交开发任务”。不要因为你自己不能编辑文件就拒绝转交。可以先调用 workbench_status 确认当前项目与任务。工具未发现、未获语音授权或调用失败时，明确说尚未交给 Codex 并说明原因；不要声称 Codex 做不到。只有工具返回 taskId 才能说已交给 Codex，完成情况以 workbench_status 的真实状态为准。用户明确说关闭语音、停止收音时调用 workbench_voice_close，只关闭语音，不停止 Codex 任务。不能用语音批准额外权限。';

export const voiceHandoffSchema = z.strictObject({
  captureId: z.uuid().nullable(),
  status: z.enum(['draft-only', 'awaiting-tool', 'submitted', 'handled', 'blocked', 'unhandled']),
  message: z.string().max(600),
  taskId: z.uuid().nullable(),
});

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
  status: z.enum([
    'disconnected',
    'connecting',
    'ready',
    'listening',
    'processing',
    'speaking',
    'failed',
  ]),
  conversationActive: z.boolean().default(false),
  speechId: z.uuid().nullable().default(null),
  draft: z.string(),
  captureId: z.uuid().nullable(),
  subtitle: z.string(),
  error: z.string().nullable(),
  allowVoiceSubmit: z.boolean(),
  deviceToolsReady: z.boolean().default(false),
  handoff: voiceHandoffSchema.nullable().default(null),
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
  z.strictObject({ action: z.literal('start-session') }),
  z.strictObject({ action: z.literal('stop-session') }),
  z.strictObject({ action: z.literal('stop-listening') }),
  z.strictObject({ action: z.literal('stop-speaking') }),
  z.strictObject({ action: z.literal('speak'), text: z.string().min(1).max(1000) }),
  z.strictObject({ action: z.literal('install-wake') }),
  z.strictObject({ action: z.literal('arm-wake'), keyword: wakeKeywordSchema }),
  z.strictObject({ action: z.literal('wake-keyword'), keyword: wakeKeywordSchema }),
  z.strictObject({ action: z.literal('stop-wake') }),
  z.strictObject({ action: z.literal('context-details'), open: z.boolean() }),
]);
export type VoiceState = z.infer<typeof voiceStateSchema>;
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;
export type VoiceCommand = z.infer<typeof voiceCommandSchema>;
