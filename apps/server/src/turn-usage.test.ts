import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { summarizeTurnUsage, type TurnUsageRecord, zeroTokens } from './turn-usage.js';

function record(): TurnUsageRecord {
  return {
    taskId: randomUUID(),
    conversationId: randomUUID(),
    codexId: 'thread',
    turnId: 'turn',
    previousTaskId: null,
    baseline: { ...zeroTokens, inputTokens: 100, totalTokens: 120, outputTokens: 20 },
    total: {
      totalTokens: 360,
      inputTokens: 300,
      outputTokens: 60,
      cachedInputTokens: 120,
      cacheWriteInputTokens: null,
      reasoningOutputTokens: 20,
    },
    counterReset: false,
    updatedAt: new Date().toISOString(),
  };
}
it('subtracts cumulative counters, preserving unknown optional counters', () => {
  expect(summarizeTurnUsage(record(), null)).toMatchObject({
    status: 'reported',
    tokens: {
      totalTokens: 240,
      inputTokens: 200,
      outputTokens: 40,
      cachedInputTokens: 120,
      cacheWriteInputTokens: null,
      reasoningOutputTokens: 20,
    },
  });
});
it('keeps missing reports/baselines and reset counters unknown, including a reset above the baseline', () => {
  const row = record();
  expect(summarizeTurnUsage({ ...row, total: null }, null).status).toBe('waiting');
  expect(summarizeTurnUsage({ ...row, baseline: null }, null).status).toBe('baseline-missing');
  expect(
    summarizeTurnUsage({ ...row, baseline: row.total, total: row.baseline }, null),
  ).toMatchObject({
    status: 'counter-reset',
    tokens: null,
  });
  expect(summarizeTurnUsage({ ...row, counterReset: true }, null).tokens).toBeNull();
  expect(summarizeTurnUsage({ ...row, total: row.baseline }, null).tokens?.totalTokens).toBe(0);
});
it('corrects the baseline with late predecessor reports and rejects cross-thread attribution', () => {
  const row = record();
  const previous = { ...record(), conversationId: row.conversationId, total: row.total };
  row.previousTaskId = previous.taskId;
  row.total = { ...zeroTokens, totalTokens: 480, inputTokens: 400, outputTokens: 80 };
  expect(summarizeTurnUsage(row, previous).tokens?.totalTokens).toBe(120);
  expect(summarizeTurnUsage(row, { ...previous, codexId: 'foreign' }).tokens?.totalTokens).toBe(
    360,
  );
  expect(
    summarizeTurnUsage(row, { ...previous, conversationId: randomUUID() }).tokens?.totalTokens,
  ).toBe(360);
});
