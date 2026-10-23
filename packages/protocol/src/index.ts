import { z } from 'zod';

export const selectionSchema = z.strictObject({
  artifactId: z.string().uuid(),
  artifactRevision: z.number().int().nonnegative(),
  elementId: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
});

export const submitCommandSchema = z
  .strictObject({
    commandId: z.string().uuid(),
    source: z.enum(['keyboard', 'voice', 'pointer']),
    text: z.string().trim().min(1).max(4000),
    expectedRevision: z.number().int().nonnegative(),
    selection: selectionSchema.optional(),
  })
  .refine((value) => value.source !== 'pointer' || value.selection !== undefined, {
    message: 'Pointer commands require a versioned selection',
    path: ['selection'],
  });

export const commandSchema = z.strictObject({
  id: z.string().uuid(),
  source: z.enum(['keyboard', 'voice', 'pointer']),
  text: z.string(),
  status: z.literal('draft'),
  createdAt: z.string().datetime(),
  selection: selectionSchema.optional(),
});

export const artifactSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  title: z.string(),
});

export const sessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  commands: z.array(commandSchema),
  artifact: artifactSchema.nullable(),
  integrations: z.strictObject({
    codex: z.literal('not-configured'),
    lingxi: z.literal('not-configured'),
  }),
});

export const errorSchema = z.strictObject({
  error: z.enum([
    'invalid_request',
    'revision_conflict',
    'command_id_conflict',
    'selection_stale',
    'forbidden_origin',
    'forbidden_host',
    'internal_error',
  ]),
});

export type Selection = z.infer<typeof selectionSchema>;
export type SubmitCommand = z.infer<typeof submitCommandSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type ErrorCode = z.infer<typeof errorSchema>['error'];

export const CODEX_SETUP_PACKAGE = '@openai/codex@latest';

export const setupStatusSchema = z.strictObject({
  checkedAt: z.string().datetime(),
  host: z.strictObject({
    platform: z.string(),
    arch: z.string(),
    nodeVersion: z.string(),
    nodeSupported: z.boolean(),
  }),
  capabilities: z.strictObject({ codexTasks: z.literal(false), lingxiVoice: z.literal(false) }),
});

export const codexCheckSchema = z.strictObject({
  checkedAt: z.string().datetime(),
  status: z.enum(['ready', 'not-installed', 'signed-out', 'failed', 'timed-out']),
  cliVersion: z.string().nullable(),
  authentication: z.enum(['chatgpt', 'api-key', 'provider']).nullable(),
});

export const setupInspectionSchema = z.strictObject({
  environment: setupStatusSchema,
  codex: codexCheckSchema,
  lingxi: z.strictObject({
    checkedAt: z.string().datetime(),
    status: z.literal('unavailable'),
    reason: z.literal('adapter-not-connected'),
  }),
});
export type SetupInspection = z.infer<typeof setupInspectionSchema>;

export type SetupStatus = z.infer<typeof setupStatusSchema>;
export type CodexCheck = z.infer<typeof codexCheckSchema>;

export const codexAuthorizationUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        ['auth.openai.com', 'chatgpt.com'].includes(url.hostname)
      );
    } catch {
      return false;
    }
  });
export const codexSetupRequestSchema = z.strictObject({
  requestId: z.string().uuid(),
  kind: z.enum(['install', 'login']),
});
export const codexSetupActionSchema = z.strictObject({
  id: z.string().uuid(),
  kind: z.enum(['install', 'login']),
  state: z.enum([
    'installing',
    'starting-login',
    'waiting-for-login',
    'checking',
    'cancelling',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  error: z
    .enum([
      'install_failed',
      'verification_failed',
      'login_failed',
      'timed_out',
      'custom_path_configured',
    ])
    .nullable(),
  authUrl: codexAuthorizationUrlSchema.nullable(),
  check: codexCheckSchema.nullable(),
  updatedAt: z.string().datetime(),
});
export const codexSetupStateSchema = z.strictObject({ action: codexSetupActionSchema.nullable() });
export type CodexSetupAction = z.infer<typeof codexSetupActionSchema>;
export type CodexSetupRequest = z.infer<typeof codexSetupRequestSchema>;

// Connection state is independent from durable session and task state.
export type AgentEvent =
  | { type: 'task.started'; taskId: string }
  | { type: 'task.progress'; taskId: string; message: string }
  | { type: 'task.completed'; taskId: string }
  | { type: 'task.failed'; taskId: string; message: string }
  | { type: 'task.interrupted'; taskId: string };

export interface AgentAdapter {
  start(input: {
    text: string;
    projectPath: string;
    selection?: Selection;
  }): AsyncIterable<AgentEvent>;
  interrupt(taskId: string): Promise<void>;
}

export type VoiceEvent =
  | { type: 'capture.started' }
  | { type: 'transcript.partial'; text: string }
  | { type: 'transcript.final'; text: string }
  | { type: 'capture.stopped' }
  | { type: 'voice.failed'; message: string };

export interface VoiceAdapter {
  capture(signal: AbortSignal): AsyncIterable<VoiceEvent>;
  speak(text: string, signal: AbortSignal): Promise<void>;
}
