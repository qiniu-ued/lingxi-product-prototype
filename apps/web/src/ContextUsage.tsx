import type { ThreadRuntime } from '@lingxi/protocol';

const format = (value: number | null) =>
  value === null ? '未报告' : value.toLocaleString('zh-CN');
const labels = [
  ['totalTokens', '总 token'],
  ['inputTokens', '输入'],
  ['cachedInputTokens', '缓存读取（输入内）'],
  ['cacheWriteInputTokens', '缓存写入（输入内）'],
  ['outputTokens', '输出'],
  ['reasoningOutputTokens', '推理（输出内）'],
] as const;
export function ContextUsage({
  runtime,
  turnId,
  compact = false,
}: {
  runtime: ThreadRuntime | null;
  turnId: string | null | undefined;
  compact?: boolean;
}) {
  const usage = runtime?.usage,
    capacity = usage?.modelContextWindow,
    used = usage?.last.totalTokens;
  const known = capacity !== null && capacity !== undefined && capacity > 0 && used !== undefined;
  const percent = known ? (used / capacity) * 100 : null;
  return (
    <section className={`context-usage ${compact ? 'compact' : ''}`} aria-label="上下文用量">
      <div className="context-summary">
        <strong>上下文{percent === null ? '' : ` · ${percent.toFixed(1)}%`}</strong>
        <span>
          {usage
            ? `${format(used ?? null)} / ${capacity ? format(capacity) : '容量未报告'} tokens`
            : '等待 Codex 报告用量'}
        </span>
      </div>
      {known && (
        <meter
          aria-label="上下文窗口占用"
          min={0}
          max={capacity}
          value={Math.min(used, capacity)}
          high={capacity * 0.85}
          low={capacity * 0.65}
          optimum={0}
          aria-valuetext={`${percent?.toFixed(1)}% 已使用`}
        />
      )}
      {usage && (
        <small>
          {runtime?.usageTurnId === turnId ? '本轮最近报告' : '上次报告'}
          {known ? ` · 剩余 ${format(Math.max(0, capacity - used))} tokens` : ' · 窗口容量未知'}
        </small>
      )}
      {!compact && (
        <details>
          <summary>上下文使用详情</summary>
          {usage ? (
            <>
              <table>
                <caption>Codex token 用量</caption>
                <thead>
                  <tr>
                    <th>类别</th>
                    <th>最近一次模型请求</th>
                    <th>线程累计</th>
                  </tr>
                </thead>
                <tbody>
                  {labels.map(([key, label]) => (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      <td>{format(usage.last[key])}</td>
                      <td>{format(usage.total[key])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                占用率使用最近请求的总 token ÷
                报告的窗口容量。累计消耗不代表当前占用；缓存和推理是已有计数的子项，不重复相加。
              </p>
              <p>
                这是上次报告的用量，不含待发送草稿的估算；自动压缩后可能下降。Codex
                未提供系统提示、文件、工具的逐项 token 归因。
              </p>
              {runtime?.usageUpdatedAt && (
                <small>报告时间：{new Date(runtime.usageUpdatedAt).toLocaleString()}</small>
              )}
            </>
          ) : (
            <p>模型执行后才可能报告数据；缺少报告时不估算窗口容量或显示虚假的 0%。</p>
          )}
        </details>
      )}
    </section>
  );
}
