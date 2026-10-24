import type { ContextAttachment, WorkbenchState } from '@lingxi/protocol';
import { useState } from 'react';
import { z } from 'zod';

const catalogSchema = z.object({
  models: z
    .object({
      data: z.array(
        z.object({
          id: z.string(),
          model: z.string(),
          displayName: z.string(),
          supportedReasoningEfforts: z
            .array(z.object({ reasoningEffort: z.string(), description: z.string() }))
            .optional(),
        }),
      ),
    })
    .nullable(),
  skills: z.unknown(),
  mcp: z.unknown(),
  limits: z.unknown(),
});
export function WorkspaceTools({
  state,
  operate,
  attach,
}: {
  state: WorkbenchState;
  operate: (operation: string, body: unknown) => Promise<boolean>;
  attach: (value: ContextAttachment) => void;
}) {
  const [catalog, setCatalog] = useState<z.infer<typeof catalogSchema> | null>(null),
    [error, setError] = useState('');
  const [context, setContext] = useState(''),
    [title, setTitle] = useState('上下文');
  return (
    <section className="workspace-tool">
      <button
        type="button"
        onClick={async () => {
          try {
            const response = await fetch('/api/workbench/catalog');
            if (!response.ok) throw new Error();
            setCatalog(catalogSchema.parse(await response.json()));
            setError('');
          } catch {
            setError('部分能力不可用，请检查 CLI 版本或登录状态。');
          }
        }}
      >
        读取 Skills、MCP 和账号额度
      </button>
      <label>
        <input
          type="checkbox"
          checked={state.settings.plan}
          onChange={(e) =>
            void operate('workspace', {
              action: 'settings',
              settings: { ...state.settings, plan: e.target.checked },
            })
          }
        />
        先给计划并请求确认
      </label>
      <p>此开关在指令中要求先确认计划。官方 Plan collaboration mode 的协议接入仍待兼容验证。</p>
      {catalog &&
        ['skills', 'mcp', 'limits'].map((name) => (
          <details key={name}>
            <summary>{name}</summary>
            <pre>{JSON.stringify(catalog[name as 'skills' | 'mcp' | 'limits'], null, 2)}</pre>
          </details>
        ))}
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
