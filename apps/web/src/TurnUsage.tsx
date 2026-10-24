import type { Task, TurnUsage as Usage } from '@lingxi/protocol';

const format = (value: number | null) =>
  value === null ? '未报告' : value.toLocaleString('zh-CN');
export function TurnUsage({
  usage,
  status,
  compact,
}: {
  usage: Usage | undefined;
  status: Task['status'];
  compact: boolean;
}) {
  if (!['completed', 'failed', 'interrupted'].includes(status)) return null;
  const tokens = usage?.tokens;
  const cacheRate =
    tokens &&
    tokens.inputTokens > 0 &&
    tokens.cachedInputTokens !== null &&
    tokens.cachedInputTokens <= tokens.inputTokens
      ? `${((tokens.cachedInputTokens / tokens.inputTokens) * 100).toFixed(1)}%`
      : tokens?.inputTokens === 0
        ? '不适用（无输入）'
        : '未报告';
  const unavailable =
    usage?.status === 'baseline-missing'
      ? '缺少起始累计值，无法计算本轮用量'
      : usage?.status === 'counter-reset'
        ? '累计计数发生重置，本轮用量不可计算'
        : '本轮用量未报告';
  return (
    <section className={`turn-usage ${compact ? 'compact' : ''}`} aria-label="本轮 Token 用量">
      <div className="turn-usage-summary">
        <span>{tokens ? `本轮 ${format(tokens.totalTokens)} tokens` : unavailable}</span>
        <span>缓存命中率 {cacheRate}</span>
      </div>
      {tokens && (
        <small>
          输入 {format(tokens.inputTokens)} · 输出 {format(tokens.outputTokens)}
          {status !== 'completed' ? ' · 截至最后报告的用量' : ''}
        </small>
      )}
      {!compact && tokens && (
        <details>
          <summary>本轮用量明细</summary>
          <dl>
            <dt>缓存读取（输入内）</dt>
            <dd>{format(tokens.cachedInputTokens)}</dd>
            <dt>缓存写入（输入内）</dt>
            <dd>{format(tokens.cacheWriteInputTokens)}</dd>
            <dt>推理（输出内）</dt>
            <dd>{format(tokens.reasoningOutputTokens)}</dd>
          </dl>
          <p>
            本轮用量取线程累计值在本轮前后的差值，包含本轮多次模型请求。缓存命中率 = 本轮缓存读取
            token ÷ 本轮输入 token；缓存和推理是子项，不重复计入总量。
          </p>
          <small>
            以最后收到的报告为准；迟到报告会更新统计。
            {usage?.updatedAt && ` 报告时间：${new Date(usage.updatedAt).toLocaleString()}`}
          </small>
        </details>
      )}
    </section>
  );
}
