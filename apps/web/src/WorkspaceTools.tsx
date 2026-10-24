import {
  type ContextAttachment,
  type ToolsCatalog,
  toolsCatalogSchema,
  type WorkbenchState,
} from '@lingxi/protocol';
import { useEffect, useRef, useState } from 'react';

const connection: Record<string, string> = {
  notStarted: '尚未启动',
  starting: '连接中',
  connected: '已连接',
  authenticationRequired: '需要登录',
  failed: '连接失败',
  cancelled: '已取消',
  disabled: '已停用',
};
const auth: Record<string, string> = {
  unknown: '登录状态未知',
  unsupported: '不支持授权登录',
  notLoggedIn: '尚未登录',
  bearerToken: '已配置令牌',
  oAuth: '已登录',
};
const scopes: Record<string, string> = {
  user: '个人',
  repo: '项目',
  system: '内置',
  admin: '组织',
};
function QuotaWindow({
  value,
  fallback,
}: {
  value: ToolsCatalog['limits']['buckets'][number]['primary'];
  fallback: string;
}) {
  if (!value) return <p>{fallback}：未报告</p>;
  const duration = value.windowDurationMins;
  const label = duration
    ? duration % 60 === 0
      ? `${duration / 60} 小时窗口`
      : `${duration} 分钟窗口`
    : fallback;
  return (
    <div className="quota-window">
      <span>
        {label} · 已用 {value.usedPercent.toFixed(1)}%
      </span>
      <progress aria-label={label} max={100} value={Math.min(100, value.usedPercent)} />
      <small>
        {value.resetsAt === null
          ? '重置时间未报告'
          : `重置于 ${new Date(value.resetsAt * 1000).toLocaleString()}`}
      </small>
    </div>
  );
}
export function WorkspaceTools({
  state,
  attach,
}: {
  state: WorkbenchState;
  operate: (operation: string, body: unknown) => Promise<boolean>;
  attach: (value: ContextAttachment) => void;
}) {
  const [catalog, setCatalog] = useState<ToolsCatalog | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const [context, setContext] = useState(''),
    [title, setTitle] = useState('上下文');
  const controller = useRef<AbortController | null>(null);
  const projectId = state.project?.id;
  useEffect(() => {
    setCatalog((value) => (value?.projectId === projectId ? value : null));
    setError('');
    setLoading(false);
    return () => controller.current?.abort();
  }, [projectId]);
  async function load() {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/workbench/catalog', { signal: active.signal });
      if (!response.ok) throw new Error();
      const value = toolsCatalogSchema.parse(await response.json());
      if (!active.signal.aborted && value.projectId === projectId) setCatalog(value);
    } catch {
      if (!active.signal.aborted) setError('读取失败，请检查 Codex 连接后重试。');
    } finally {
      if (controller.current === active) setLoading(false);
    }
  }
  const current = catalog?.projectId === projectId ? catalog : null;
  return (
    <section className="workspace-tool">
      <button type="button" disabled={loading || !projectId} onClick={() => void load()}>
        {loading
          ? '正在读取…'
          : current
            ? '刷新 Skills、MCP 和账号额度'
            : '读取 Skills、MCP 和账号额度'}
      </button>
      {current ? (
        <>
          <section aria-label="Skills">
            <h3>Skills · 技能</h3>
            {current.skills.status === 'unavailable' ? (
              <p>技能列表暂不可用，请刷新重试。</p>
            ) : (
              <>
                {!current.skills.items.length && <p>当前项目没有可显示的技能。</p>}
                {current.skills.items.map((skill) => (
                  <article className="catalog-card" key={`${skill.path}:${skill.name}`}>
                    <h4>
                      {skill.displayName}{' '}
                      <small>
                        {skill.enabled === null
                          ? '启用状态未知'
                          : skill.enabled
                            ? '已启用'
                            : '已停用'}
                      </small>
                    </h4>
                    <p>{skill.description || '暂无说明'}</p>
                    <small>
                      {scopes[skill.scope] ?? skill.scope} · {skill.name}
                    </small>
                    <details>
                      <summary>查看来源</summary>
                      <code>{skill.path}</code>
                    </details>
                  </article>
                ))}
                {current.skills.issues.map((issue) => (
                  <p role="alert" key={issue.path}>
                    {issue.message} <code>{issue.path}</code>
                  </p>
                ))}
              </>
            )}
          </section>
          <section aria-label="MCP">
            <h3>MCP · 工具连接</h3>
            {current.mcp.status === 'unavailable' ? (
              <p>工具连接列表暂不可用，请刷新重试。</p>
            ) : !current.mcp.items.length ? (
              <p>尚未发现 MCP 连接。</p>
            ) : (
              current.mcp.items.map((server) => (
                <article className="catalog-card" key={server.name}>
                  <h4>{server.name}</h4>
                  <p>
                    {server.runtimeStatus
                      ? (connection[server.runtimeStatus] ?? '连接状态未知')
                      : '连接状态未报告'}{' '}
                    · {auth[server.authStatus] ?? '登录状态未知'}
                  </p>
                  <small>
                    {server.tools.length} 个工具 · {server.resourceCount} 项资源
                  </small>
                  {server.toolsUnavailable && (
                    <p role="alert">工具列表读取失败，请检查连接后刷新。</p>
                  )}
                  {!!server.tools.length && (
                    <details>
                      <summary>查看工具</summary>
                      <ul>
                        {server.tools.map((tool) => (
                          <li key={tool.name}>
                            <strong>{tool.name}</strong>
                            {tool.description && <p>{tool.description}</p>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </article>
              ))
            )}
          </section>
          <section aria-label="账号额度">
            <h3>账号额度</h3>
            {current.limits.status === 'unavailable' ? (
              <p>额度暂不可用，请刷新重试。</p>
            ) : (
              <>
                <p>
                  {current.limits.ordinaryUsageAllowed === null
                    ? '提供方未报告普通用量是否可用。'
                    : current.limits.ordinaryUsageAllowed
                      ? '提供方当前允许使用普通额度。'
                      : '提供方当前暂停普通额度使用。'}
                </p>
                {!current.limits.buckets.length && <p>尚未报告额度窗口，不能据此判断额度充足。</p>}
                {current.limits.buckets.map((bucket) => (
                  <article className="catalog-card" key={bucket.id}>
                    <h4>{bucket.name}</h4>
                    <QuotaWindow value={bucket.primary} fallback="主要窗口" />
                    <QuotaWindow value={bucket.secondary} fallback="次要窗口" />
                    {bucket.credits && (
                      <p>
                        {bucket.credits.unlimited
                          ? '额外额度不限量'
                          : bucket.credits.balance !== null
                            ? `额外额度余额：${bucket.credits.balance}`
                            : bucket.credits.hasCredits
                              ? '存在额外额度，余额未报告'
                              : '没有额外额度'}
                      </p>
                    )}
                  </article>
                ))}
              </>
            )}
          </section>
        </>
      ) : (
        <p>读取后查看可用技能、工具连接与账号额度。</p>
      )}
      <h3>添加上下文</h3>
      <label>
        标题
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </label>
      <textarea
        aria-label="上下文内容"
        placeholder="粘贴代码、文件片段、讨论结论或准确文本；注明文件路径和行号。"
        value={context}
        maxLength={32000}
        onChange={(e) => setContext(e.target.value)}
      />
      <button
        type="button"
        disabled={!context.trim()}
        onClick={() => {
          attach({ id: crypto.randomUUID(), kind: 'text', title, text: context });
          setContext('');
        }}
      >
        添加到对话
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
