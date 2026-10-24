import type { Task, TurnUsage as Usage } from '@lingxi/protocol';

const format = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 0 });
export function TurnUsage({ usage, status }: { usage: Usage | undefined; status: Task['status'] }) {
  const tokens = usage?.tokens;
  if (!tokens || !['completed', 'failed', 'interrupted'].includes(status)) return null;
  const cache =
    tokens.inputTokens > 0 &&
    tokens.cachedInputTokens !== null &&
    tokens.cachedInputTokens <= tokens.inputTokens
      ? `${((tokens.cachedInputTokens / tokens.inputTokens) * 100).toFixed(1)}% Cache hit.`
      : '';
  const line = `${format(tokens.totalTokens)} Token used, ${format(tokens.inputTokens)} Input, ${format(tokens.outputTokens)} Output${cache ? `, ${cache}` : '.'}`;
  return (
    <section className="turn-usage" aria-label="本轮用量摘要" title={line}>
      {line}
    </section>
  );
}
