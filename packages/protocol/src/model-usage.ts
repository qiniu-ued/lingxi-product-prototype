import { z } from 'zod';

export const reasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export const modelDescriptorSchema = z.object({
  id: z.string(),
  model: z.string().min(1),
  displayName: z.string(),
  hidden: z.boolean().optional().default(false),
  isDefault: z.boolean().optional().default(false),
  defaultReasoningEffort: z.string().nullable().optional().default(null),
  supportedReasoningEfforts: z
    .array(z.object({ reasoningEffort: z.string(), description: z.string() }))
    .optional()
    .default([]),
});
export const modelCatalogSchema = z.object({
  projectId: z.uuid(),
  data: z.array(modelDescriptorSchema),
});
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const tokenBreakdownSchema = z.object({
  totalTokens: count,
  inputTokens: count,
  outputTokens: count,
  cachedInputTokens: count.nullable().optional().default(null),
  cacheWriteInputTokens: count.nullable().optional().default(null),
  reasoningOutputTokens: count.nullable().optional().default(null),
});
export const threadTokenUsageSchema = z.object({
  total: tokenBreakdownSchema,
  last: tokenBreakdownSchema,
  modelContextWindow: count.nullable().optional().default(null),
});
export const threadRuntimeSchema = z.strictObject({
  conversationId: z.uuid(),
  codexId: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  configurationUpdatedAt: z.string().datetime().nullable(),
  usage: threadTokenUsageSchema.nullable(),
  usageTurnId: z.string().nullable(),
  usageUpdatedAt: z.string().datetime().nullable(),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;
export type ThreadRuntime = z.infer<typeof threadRuntimeSchema>;
