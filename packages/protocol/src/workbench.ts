import { z } from 'zod';

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
  questions: z.array(z.object({ id: z.string(), question: z.string() })).optional(),
});
export const previewSelectionSchema = z.strictObject({
  binding: previewBindingSchema,
  ref: z.string().min(1).max(80),
  description: z.string().max(500),
});
export type PreviewSelection = z.infer<typeof previewSelectionSchema>;
export const taskSchema = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  prompt: z.string(),
  selection: previewSelectionSchema.nullable().default(null),
  status: z.enum([
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
});
export const startTaskSchema = z.strictObject({
  requestId: z.uuid(),
  text: z.string().trim().min(1).max(4000),
  selection: previewSelectionSchema.optional(),
});
export const taskDecisionSchema = z.strictObject({
  taskId: z.uuid(),
  approvalId: z.string(),
  decision: z.enum(['accept', 'decline']),
  answers: z.record(z.string(), z.string().max(4000)).optional(),
});
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
  bounds(input: { x: number; y: number; width: number; height: number }): void;
}
