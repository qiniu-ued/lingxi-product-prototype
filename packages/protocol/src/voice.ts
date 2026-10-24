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
export const wakePreferenceSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  source: z.enum(['default', 'user', 'legacy-review', 'unavailable']),
});
export type WakePreference = z.infer<typeof wakePreferenceSchema>;
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
  wakePreference: wakePreferenceSchema.default({
    version: 1,
    enabled: false,
    source: 'legacy-review',
  }),
  wakeAutoSuspended: z.boolean().default(false),
  connectionPreference: wakePreferenceSchema.default({
    version: 1,
    enabled: false,
    source: 'legacy-review',
  }),
  connection: z
    .strictObject({
      attempt: z.number().int().nonnegative(),
      nextRetryAt: z.string().nullable(),
      exhausted: z.boolean(),
    })
    .default({ attempt: 0, nextRetryAt: null, exhausted: false }),
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
  z.strictObject({ action: z.literal('retry-connection') }),
  z.strictObject({ action: z.literal('connection-auto'), enabled: z.boolean() }),
  z.strictObject({ action: z.literal('disconnect') }),
  z.strictObject({ action: z.literal('listen') }),
  z.strictObject({ action: z.literal('start-session') }),
  z.strictObject({ action: z.literal('stop-session') }),
  z.strictObject({ action: z.literal('stop-listening') }),
  z.strictObject({ action: z.literal('stop-speaking') }),
  z.strictObject({ action: z.literal('speak'), text: z.string().min(1).max(1000) }),
  z.strictObject({ action: z.literal('install-wake') }),
  z.strictObject({
    action: z.literal('arm-wake'),
    keyword: wakeKeywordSchema,
    automatic: z.boolean().optional(),
  }),
  z.strictObject({ action: z.literal('wake-auto'), enabled: z.boolean() }),
  z.strictObject({ action: z.literal('dismiss-wake') }),
  z.strictObject({ action: z.literal('pause-voice'), suspend: z.boolean().optional() }),
  z.strictObject({ action: z.literal('wake-keyword'), keyword: wakeKeywordSchema }),
  z.strictObject({ action: z.literal('stop-wake') }),
  z.strictObject({ action: z.literal('context-details'), open: z.boolean() }),
]);
export type VoiceState = z.infer<typeof voiceStateSchema>;
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;
export type VoiceCommand = z.infer<typeof voiceCommandSchema>;

export const voiceDiagnosticKindSchema = z.enum([
  'service-connecting',
  'service-ready',
  'service-disconnected',
  'service-failed',
  'service-retry-scheduled',
  'service-retry-paused',
  'service-stop-requested',
  'voice-paused',
  'capture-started',
  'capture-ended',
  'asr-received',
  'asr-discarded',
  'tools-discovered',
  'tool-called',
  'tool-rejected',
  'tool-returned',
  'rpc-replayed',
  'handoff-missing',
  'task-submitted',
  'task-status',
  'assistant-start',
  'assistant-sentence',
  'assistant-stop',
  'protocol-rejected',
]);
export const voiceDiagnosticCodeSchema = z.enum([
  'voice_submit_disabled',
  'capture_required',
  'capture_expired',
  'voice_context_changed',
  'project_required',
  'task_running',
  'selection_stale',
  'capture_already_submitted',
  'mode_change_pending',
  'invalid_arguments',
  'unsupported_tool',
  'operation_rejected',
  'invalid_rpc',
  'unsupported_method',
  'duplicate_request',
  'request_conflict',
  'authentication_failed',
  'network_failure',
  'handshake_timeout',
  'protocol_incompatible',
  'audio_unavailable',
  'no_tool_call',
  'tts_out_of_order',
]);
export const voiceDiagnosticToolSchema = z.enum([
  'workbench_status',
  'workbench_voice_close',
  'workbench_submit',
  'workbench_interrupt',
  'workbench_set_mode',
  'workbench_context_details',
  'unknown',
]);
export const voiceDiagnosticSourceSchema = z.enum([
  'websocket',
  'heartbeat',
  'handshake',
  'operator',
  'device-tool',
  'configuration',
  'system',
  'microphone',
  'app',
]);
export const voiceDiagnosticReasonSchema = z.enum([
  'transport_close',
  'transport_error',
  'keepalive_timeout',
  'handshake_timeout',
  'authentication_failed',
  'protocol_incompatible',
  'audio_playback_failed',
  'manual_disconnect',
  'voice_close',
  'connection_disabled',
  'configuration_saved',
  'system_suspend',
  'shutdown',
  'audio_frames_lost',
  'voice_paused',
]);
export const voiceDiagnosticEventSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  kind: voiceDiagnosticKindSchema,
  sessionId: z.uuid().nullable(),
  captureId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  conversationId: z.uuid().nullable(),
  taskId: z.uuid().nullable(),
  tool: voiceDiagnosticToolSchema.optional(),
  code: voiceDiagnosticCodeSchema.optional(),
  source: voiceDiagnosticSourceSchema.optional(),
  reason: voiceDiagnosticReasonSchema.optional(),
  closeCode: z.number().int().min(1000).max(4999).optional(),
  explicitClose: z.boolean().optional(),
  retryAttempt: z.number().int().min(0).max(6).optional(),
  retryDelayMs: z.number().int().min(1000).max(30000).optional(),
  status: z
    .enum([
      'queued',
      'starting',
      'running',
      'waiting',
      'stopping',
      'completed',
      'failed',
      'interrupted',
    ])
    .optional(),
  characters: z.number().int().min(0).max(4000).optional(),
});
export type VoiceDiagnosticEvent = z.infer<typeof voiceDiagnosticEventSchema>;
export const voiceBuildSchema = z.strictObject({
  version: z.string().max(80),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  dirty: z.boolean(),
  builtAt: z.iso.datetime().nullable(),
});
export const voiceDiagnosticsSchema = z.strictObject({
  build: voiceBuildSchema.default({
    version: 'unknown',
    commit: null,
    dirty: false,
    builtAt: null,
  }),
  enabled: z.boolean(),
  capacity: z.literal(128),
  retentionMinutes: z.literal(30),
  dropped: z.number().int().nonnegative(),
  events: z.array(voiceDiagnosticEventSchema).max(128),
  snapshot: z.strictObject({
    connection: voiceStateSchema.shape.status,
    projectSelected: z.boolean(),
    conversationSelected: z.boolean(),
    voiceSubmitEnabled: z.boolean(),
    toolsListed: z.boolean(),
    captureActive: z.boolean(),
    conversationActive: z.boolean().default(false),
    wakeStatus: voiceStateSchema.shape.wake.unwrap().shape.status.default('off'),
    autoReconnectEnabled: z.boolean().default(false),
    retryAttempt: z.number().int().min(0).max(6).default(0),
    retryExhausted: z.boolean().default(false),
  }),
});
export type VoiceDiagnostics = z.infer<typeof voiceDiagnosticsSchema>;

// Explicit opt-in content debugging is separate from default metadata exports.
export const voiceDebugEventSchema = z.strictObject({
  sequence: z.number().int().positive(),
  at: z.iso.datetime(),
  direction: z.enum(['inbound', 'outbound', 'local']),
  event: z.enum(['message', 'close', 'error', 'http-response', 'state']),
  sessionId: z.uuid().nullable(),
  captureId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  conversationId: z.uuid().nullable(),
  taskId: z.uuid().nullable(),
  payload: z.string().max(8192),
  truncated: z.boolean(),
});
export type VoiceDebugEvent = z.infer<typeof voiceDebugEventSchema>;
export const voiceDebugSchema = z.strictObject({
  build: voiceBuildSchema,
  enabled: z.boolean(),
  capacity: z.literal(64),
  retentionMinutes: z.literal(10),
  maxPayloadCharacters: z.literal(8192),
  dropped: z.number().int().nonnegative(),
  events: z.array(voiceDebugEventSchema).max(64),
});
export type VoiceDebugState = z.infer<typeof voiceDebugSchema>;

export const voiceMessageSchema = z.strictObject({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  text: z.string().max(8000),
  state: z.enum(['streaming', 'final', 'interrupted']),
  at: z.iso.datetime(),
});
export const voiceTurnSchema = z.strictObject({
  id: z.uuid(),
  sessionId: z.uuid().nullable(),
  captureId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  conversationId: z.uuid().nullable(),
  at: z.iso.datetime(),
  messages: z.array(voiceMessageSchema).max(8),
  handoff: voiceHandoffSchema.nullable(),
  taskStatus: z
    .enum([
      'queued',
      'starting',
      'running',
      'waiting',
      'stopping',
      'completed',
      'failed',
      'interrupted',
    ])
    .nullable(),
});
export type VoiceTurn = z.infer<typeof voiceTurnSchema>;
export const voiceConversationSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  turns: z.array(voiceTurnSchema).max(24),
});
export type VoiceConversationState = z.infer<typeof voiceConversationSchema>;
