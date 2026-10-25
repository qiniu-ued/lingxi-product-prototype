import type { WorkbenchState } from '@lingxi/protocol';
import { useState } from 'react';

export function ConversationNavigation({
  state,
  connected,
  busy,
  running,
  onSelect,
  onNew,
}: {
  state: WorkbenchState | null;
  connected: boolean;
  busy: boolean;
  running: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [search, setSearch] = useState('');
  const current = state?.threads.find((thread) => thread.id === state.selectedThreadId);
  const parent = state?.threads.find(
    (thread) => thread.id === current?.parentId && thread.projectId === state.project?.id,
  );
  const conversations =
    state?.threads.filter(
      (thread) =>
        thread.projectId === state.project?.id &&
        (!thread.archived || thread.id === current?.id || thread.id === parent?.id),
    ) ?? [];
  const matches = conversations.filter((thread) =>
    thread.title.toLowerCase().includes(search.toLowerCase()),
  );
  const visible = conversations.filter(
    (thread) => thread.id === current?.id || matches.includes(thread),
  );
  const unavailable = !connected || busy || running || !state?.project;
  return (
    <nav className="conversation-navigation" aria-label="项目会话">
      <div className="conversation-navigation-row">
        <label htmlFor="conversation-select">会话</label>
        <select
          id="conversation-select"
          aria-label="切换对话"
          title={current?.title}
          disabled={unavailable || !conversations.length}
          value={current?.id ?? ''}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="" disabled>
            {!state ? '正在读取会话…' : '选择对话'}
          </option>
          {visible.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.title}
              {thread.archived ? '（已归档）' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="新对话"
          title="新对话"
          disabled={unavailable}
          onClick={onNew}
        >
          ＋
        </button>
        {current?.parentId && (
          <button
            type="button"
            disabled={unavailable || !parent}
            title={parent ? `返回：${parent.title}` : '原对话已不可用，请从会话列表选择'}
            onClick={() => {
              if (parent) onSelect(parent.id);
            }}
          >
            返回原对话
          </button>
        )}
      </div>
      {!!conversations.length && (
        <input
          type="search"
          aria-label="搜索对话"
          placeholder="搜索会话"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSearch('');
          }}
        />
      )}
      <small role="status">
        {!state
          ? '正在读取会话列表…'
          : !connected
            ? '会话列表连接中断，正在重连；当前内容保留。'
            : !state.project
              ? '选择项目后显示会话。'
              : !conversations.length
                ? '暂无会话，可以新建对话。'
                : running
                  ? '任务进行中，结束后可切换会话；不会自动中断任务。'
                  : search && !matches.length
                    ? '没有匹配的会话，当前选择仍保留。'
                    : current?.parentId && !parent
                      ? '原对话已不可用，可从列表选择其他会话。'
                      : current?.kind === 'fork'
                        ? '分支对话 · 与原对话共享项目文件'
                        : current?.kind === 'sidechat'
                          ? 'Sidechat · 只读讨论'
                          : '切换会话只切换聊天，不回退项目文件。'}
      </small>
    </nav>
  );
}
