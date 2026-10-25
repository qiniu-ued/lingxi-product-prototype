import type { ContextAttachment } from '@lingxi/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import {
  ConfigurationButton,
  ConfigurationSelect,
  ConfigurationTextArea,
} from './ConfigurationControls.js';

const gitSchema = z.object({ status: z.string(), staged: z.string(), unstaged: z.string() });
export function DiffPanel({
  diff,
  projectId,
  attach,
}: {
  diff: string;
  projectId: string | undefined;
  attach: (value: ContextAttachment) => void;
}) {
  const [git, setGit] = useState<z.infer<typeof gitSchema> | null>(null),
    [error, setError] = useState(''),
    [source, setSource] = useState('turn');
  const [comment, setComment] = useState(''),
    [selected, setSelected] = useState('');
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/workbench/git');
      if (!response.ok) throw new Error();
      setGit(gitSchema.parse(await response.json()));
      setError('');
    } catch {
      setError('无法读取 Git 状态：项目可能尚未初始化 Git，或 diff 超出 2MB。');
    }
  }, []);
  // Explicit refresh after project changes; no polling Git on every token.
  useEffect(() => {
    setGit(null);
    setSelected('');
    if (projectId) void refresh();
  }, [projectId, refresh]);
  const patch =
    source === 'turn' ? diff : source === 'staged' ? (git?.staged ?? '') : (git?.unstaged ?? '');
  const lines = useMemo(() => {
    const counts = new Map<string, number>();
    return patch.split('\n').map((line, index) => {
      const count = (counts.get(line) ?? 0) + 1;
      counts.set(line, count);
      return { line, number: index + 1, key: `${line}:${count}` };
    });
  }, [patch]);
  return (
    <section className="workspace-tool">
      <div className="live-actions">
        <label htmlFor="workspace-diff-source">
          变更来源{' '}
          <ConfigurationSelect
            id="workspace-diff-source"
            value={source}
            onValueChange={(value) => {
              setSource(value);
              setSelected('');
            }}
          >
            <option value="turn">Codex 本轮 patch</option>
            <option value="unstaged">Git 未暂存</option>
            <option value="staged">Git 已暂存</option>
          </ConfigurationSelect>
        </label>
        <ConfigurationButton type="button" onClick={() => void refresh()}>
          刷新 Git
        </ConfigurationButton>
      </div>
      <pre>{git?.status || '暂无 Git 状态'}</pre>
      <p>未跟踪文件在状态中列出，不会自动读取内容。点击 diff 行或选中文本后添加评论。</p>
      <fieldset
        className="diff-lines"
        aria-label="Diff 内容"
        onMouseUp={() => {
          const selection = window.getSelection()?.toString();
          if (selection) setSelected(selection.slice(0, 32000));
        }}
      >
        {patch ? (
          lines.map(({ line, number, key }) => (
            <ConfigurationButton
              type="button"
              className={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''}
              key={key}
              onClick={() => setSelected(line)}
            >
              <span>{number}</span>
              <code>{line || ' '}</code>
            </ConfigurationButton>
          ))
        ) : (
          <p>当前来源没有 diff。</p>
        )}
      </fieldset>
      <ConfigurationTextArea
        aria-label="Diff 评论"
        placeholder="对选中的变更提出修改要求"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <ConfigurationButton
        type="button"
        disabled={!patch}
        onClick={() => {
          attach({
            id: crypto.randomUUID(),
            kind: 'diff',
            title: source === 'turn' ? 'Codex 本轮变更' : `Git ${source}`,
            text: `${selected || patch.slice(0, 24000)}\n\n评论：${comment}`.slice(0, 32000),
          });
          setComment('');
        }}
      >
        添加到对话
      </ConfigurationButton>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
