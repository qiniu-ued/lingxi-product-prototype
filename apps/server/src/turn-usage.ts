import { type TokenBreakdown, type TurnUsage, tokenBreakdownSchema } from '@lingxi/protocol';
import { z } from 'zod';

export const turnUsageRecordSchema = z.strictObject({
  taskId: z.uuid(),
  conversationId: z.uuid(),
  codexId: z.string(),
  turnId: z.string().nullable(),
  previousTaskId: z.uuid().nullable(),
  baseline: tokenBreakdownSchema.nullable(),
  total: tokenBreakdownSchema.nullable(),
  counterReset: z.boolean(),
  updatedAt: z.string().datetime().nullable(),
});
export type TurnUsageRecord = z.infer<typeof turnUsageRecordSchema>;
export const zeroTokens: TokenBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
const required = ['totalTokens', 'inputTokens', 'outputTokens'] as const;
export function countersDecreased(current: TokenBreakdown, before: TokenBreakdown) {
  return required.some((key) => current[key] < before[key]);
}
export function summarizeTurnUsage(
  record: TurnUsageRecord,
  previous: TurnUsageRecord | null,
): TurnUsage {
  // A late predecessor report corrects the next turn's baseline, even if that
  // next turn has already started/completed. Never subtract another thread.
  const baseline =
    previous?.taskId === record.previousTaskId &&
    previous.codexId === record.codexId &&
    previous.conversationId === record.conversationId
      ? (previous.total ?? record.baseline)
      : record.baseline;
  const common = { taskId: record.taskId, updatedAt: record.updatedAt, tokens: null };
  if (!record.total) return { ...common, status: 'waiting' };
  if (!baseline) return { ...common, status: 'baseline-missing' };
  if (record.counterReset || countersDecreased(record.total, baseline))
    return { ...common, status: 'counter-reset' };
  const delta = (key: keyof TokenBreakdown) => {
    const value = record.total?.[key],
      start = baseline[key];
    return value == null || start === null || value < start ? null : value - start;
  };
  return {
    ...common,
    status: 'reported',
    tokens: {
      totalTokens: record.total.totalTokens - baseline.totalTokens,
      inputTokens: record.total.inputTokens - baseline.inputTokens,
      outputTokens: record.total.outputTokens - baseline.outputTokens,
      cachedInputTokens: delta('cachedInputTokens'),
      cacheWriteInputTokens: delta('cacheWriteInputTokens'),
      reasoningOutputTokens: delta('reasoningOutputTokens'),
    },
  };
}
