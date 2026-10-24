import { z } from 'zod';
import { permissionModeSchema } from './execution.js';
import { reasoningEffortSchema, threadRuntimeSchema, turnUsageSchema } from './model-usage.js';

export const projectSchema = z.strictObject({ id: z.uuid(), name: z.string(), path: z.string() });
export const previewBindingSchema = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  revision: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  url: z.string(),
  title: z.string(),
});
export const previewActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('snapshot') }),
  z.strictObject({
    action: z.literal('click'),
    binding: previewBindingSchema,
    ref: z.string().min(1).max(80),
    requestId: z.uuid(),
  }),
  z.strictObject({
    action: z.literal('type'),
    binding: previewBindingSchema,
    ref: z.string().min(1).max(80),
    text: z.string().max(4000),
    requestId: z.uuid(),
  }),
  z.strictObject({
    action: z.literal('scroll'),
    binding: previewBindingSchema,
    deltaY: z.number().min(-2000).max(2000),
    requestId: z.uuid(),
  }),
]);
export const previewSnapshotSchema = z.strictObject({
  binding: previewBindingSchema,
  text: z.string().max(40000),
  image: z.string().max(6_000_000),
  width: z.number(),
  height: z.number(),
});
export const approvalSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['command', 'file', 'question']),
  title: z.string(),
  detail: z.string(),
  questions: z
    .array(
      z.object({
        id: z.string(),
        question: z.string(),
        header: z.string().optional(),
        isOther: z.boolean().optional(),
        isSecret: z.boolean().optional(),
        options: z
          .array(z.object({ label: z.string(), description: z.string() }))
          .nullable()
          .optional(),
      }),
    )
    .optional(),
});
export const previewSelectionSchema = z.strictObject({
  binding: previewBindingSchema,
  ref: z.string().min(1).max(80),
  description: z.string().max(500),
});
export type PreviewSelection = z.infer<typeof previewSelectionSchema>;
export const contextAttachmentSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['text', 'terminal', 'diff', 'browser', 'sidechat', 'file']),
  title: z.string().max(200),
  text: z.string().max(32000),
  selection: previewSelectionSchema.optional(),
});
export const threadSchema = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  codexId: z.string().nullable(),
  title: z.string().max(200),
  kind: z.enum(['main', 'sidechat', 'fork']),
  parentId: z.uuid().nullable(),
  archived: z.boolean(),
  createdAt: z.string().datetime(),
});
export const threadSettingsSchema = z.strictObject({
  model: z.string().max(100).nullable(),
  effort: reasoningEffortSchema.nullable(),
  plan: z.boolean(),
});
export const terminalStateSchema = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  status: z.enum(['starting', 'running', 'exited', 'failed']),
  chunks: z.array(z.object({ seq: z.number(), data: z.string() })),
  seq: z.number(),
  exitCode: z.number().nullable(),
});
export const taskSchema = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  prompt: z.string(),
  selection: previewSelectionSchema.nullable().default(null),
  status: z.enum([
    'queued',
    'starting',
    'running',
    'waiting',
    'stopping',
    'completed',
    'failed',
    'interrupted',
  ]),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  conversationId: z.uuid().nullable().optional(),
  attachments: z.array(contextAttachmentSchema).optional(),
  approvals: z.array(approvalSchema).optional(),
  diff: z.string().optional(),
  plan: z.array(z.object({ step: z.string(), status: z.string() })).optional(),
  items: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        text: z.string(),
        status: z.string().optional(),
      }),
    )
    .optional(),
  additions: z
    .array(
      z.object({
        id: z.uuid(),
        text: z.string(),
        fingerprint: z.string().optional(),
        status: z.enum(['pending', 'acknowledged', 'unconfirmed']).optional(),
      }),
    )
    .optional(),
  settings: threadSettingsSchema.optional(),
  messages: z.array(z.strictObject({ id: z.string(), text: z.string() })),
  activity: z.string(),
  approval: approvalSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const workbenchSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  desktop: z.boolean(),
  project: projectSchema.nullable(),
  task: taskSchema.nullable(),
  preview: previewBindingSchema.nullable(),
  threads: z.array(threadSchema).default([]),
  selectedThreadId: z.uuid().nullable().default(null),
  history: z.array(taskSchema).default([]),
  settings: threadSettingsSchema.default({ model: null, effort: null, plan: false }),
  terminal: terminalStateSchema.nullable().default(null),
  runtime: threadRuntimeSchema.nullable().default(null),
  turnUsage: z.array(turnUsageSchema).default([]),
  permission: permissionModeSchema.default('manual'),
});
export const startTaskSchema = z.strictObject({
  requestId: z.uuid(),
  text: z.string().trim().min(1).max(4000),
  selection: previewSelectionSchema.optional(),
  attachments: z.array(contextAttachmentSchema).max(20).default([]),
  mode: z.enum(['start', 'queue', 'steer']).default('start'),
});
export const taskDecisionSchema = z.strictObject({
  taskId: z.uuid(),
  approvalId: z.string(),
  decision: z.enum(['accept', 'decline']),
  answers: z.record(z.string(), z.string().max(4000)).optional(),
});
export const historyQuoteSchema = z.strictObject({
  taskId: z.uuid(),
  role: z.enum(['user', 'assistant']),
  messageId: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(16000),
});
export type HistoryQuote = z.infer<typeof historyQuoteSchema>;
export const workspaceCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('new-thread'), title: z.string().trim().min(1).max(200) }),
  z.strictObject({ action: z.literal('select-thread'), id: z.uuid() }),
  z.strictObject({
    action: z.literal('rename-thread'),
    id: z.uuid(),
    title: z.string().trim().min(1).max(200),
  }),
  z.strictObject({ action: z.literal('archive-thread'), id: z.uuid(), archived: z.boolean() }),
  z.strictObject({
    action: z.literal('fork'),
    taskId: z.uuid(),
    kind: z.enum(['fork', 'sidechat']),
    quote: historyQuoteSchema.optional(),
  }),
  z.strictObject({ action: z.literal('settings'), settings: threadSettingsSchema }),
  z.strictObject({ action: z.literal('set-mode'), mode: z.enum(['plan', 'default']) }),
  z.strictObject({ action: z.literal('set-permission'), permission: permissionModeSchema }),
  z.strictObject({ action: z.literal('cancel-queued'), id: z.uuid() }),
]);
export const terminalCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('open'), requestId: z.uuid() }),
  z.strictObject({ action: z.literal('write'), id: z.uuid(), data: z.string().max(16000) }),
  z.strictObject({
    action: z.literal('resize'),
    id: z.uuid(),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(2).max(200),
  }),
  z.strictObject({ action: z.literal('stop'), id: z.uuid() }),
]);
export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;
export type TerminalCommand = z.infer<typeof terminalCommandSchema>;
export type Conversation = z.infer<typeof threadSchema>;
export type ContextAttachment = z.infer<typeof contextAttachmentSchema>;
export const desktopActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('select-project') }),
  z.strictObject({ action: z.literal('new-project') }),
  z.strictObject({ action: z.literal('open-display') }),
  z.strictObject({ action: z.literal('publish-preview') }),
  z.strictObject({ action: z.literal('open-settings') }),
]);
export type Project = z.infer<typeof projectSchema>;
export type PreviewBinding = z.infer<typeof previewBindingSchema>;
export type PreviewAction = z.infer<typeof previewActionSchema>;
export type PreviewSnapshot = z.infer<typeof previewSnapshotSchema>;
export type WorkbenchState = z.infer<typeof workbenchSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskDecision = z.infer<typeof taskDecisionSchema>;
export type DesktopAction = z.infer<typeof desktopActionSchema>;
export interface DesktopApi {
  action(input: DesktopAction): Promise<void>;
  snapshot(): Promise<PreviewSnapshot | null>;
  pick(input: { binding: PreviewBinding; x: number; y: number }): Promise<PreviewSelection>;
  info(): Promise<{ platform: string; arch: string; systemVersion: string }>;
  microphone(): Promise<boolean>;
  audioFrame(pcm: ArrayBuffer): void;
  onAudio(
    listener: (value: { reset?: boolean; pcm?: string; sampleRate?: number }) => void,
  ): () => void;
  bounds(input: { x: number; y: number; width: number; height: number }): void;
}
