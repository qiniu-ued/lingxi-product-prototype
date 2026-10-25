import {
  type ExecutionOptions,
  executionOptionsSchema,
  type WorkbenchState,
} from '@lingxi/protocol';
import { useEffect, useState } from 'react';
import { ConfigurationButton, ConfigurationSelect } from './ConfigurationControls.js';

const labels = {
  manual: 'Manual · 手动审批',
  'auto-review': 'Approve for me · 自动审查',
  'full-access': 'Full Access · 完整访问',
};
export function ExecutionControls({
  state,
  busy,
  connected,
  operate,
}: {
  state: WorkbenchState;
  busy: boolean;
  connected: boolean;
  operate: (operation: string, body: unknown) => Promise<boolean>;
}) {
  const [options, setOptions] = useState<ExecutionOptions | null>(null),
    [verifying, setVerifying] = useState(false),
    [error, setError] = useState('');
  const projectId = state.project?.id;
  useEffect(() => {
    const controller = new AbortController();
    setOptions(null);
    setError('');
    if (projectId)
      void fetch('/api/workbench/execution-options', { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error();
          return executionOptionsSchema.parse(await response.json());
        })
        .then((value) => {
          if (!controller.signal.aborted && value.projectId === projectId) setOptions(value);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError('执行设置读取失败，请检查 Codex 连接。');
        });
    return () => controller.abort();
  }, [projectId]);
  const active = options?.projectId === projectId ? options : null;
  const readonly = state.threads.find((t) => t.id === state.selectedThreadId)?.kind === 'sidechat';
  async function verify() {
    setVerifying(true);
    setError('');
    try {
      const response = await fetch('/api/workbench/verify-execution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error();
      const value = executionOptionsSchema.parse(await response.json());
      if (value.projectId === projectId) setOptions(value);
    } catch {
      setError('验证未完成，请检查 CLI 版本、登录状态和配置目录权限。');
    } finally {
      setVerifying(false);
    }
  }
  return (
    <section className="execution-controls" aria-label="执行设置">
      <fieldset disabled={busy || verifying || !connected || !projectId}>
        <legend>执行设置 · 新提交生效</legend>
        <label htmlFor="collaboration-mode">工作模式</label>
        <ConfigurationSelect
          id="collaboration-mode"
          disabled={busy || verifying || !connected || !projectId}
          value={state.settings.plan ? 'plan' : 'default'}
          onValueChange={(mode) => void operate('workspace', { action: 'set-mode', mode })}
        >
          <option value="default">执行模式</option>
          <option value="plan" disabled={!active?.plan}>
            计划模式{!active?.plan ? '（尚不可用）' : ''}
          </option>
        </ConfigurationSelect>
        <label htmlFor="permission-mode">权限</label>
        <ConfigurationSelect
          id="permission-mode"
          value={readonly ? 'sidechat' : state.permission}
          disabled={busy || verifying || !connected || !projectId || readonly || !active}
          onValueChange={(permission) =>
            void operate('workspace', { action: 'set-permission', permission })
          }
        >
          {readonly && <option value="sidechat">Sidechat · 只读</option>}
          {Object.entries(labels).map(([key, label]) => (
            <option
              key={key}
              value={key}
              disabled={!active?.permissions[key as keyof typeof labels]}
            >
              {label}
              {active && !active.permissions[key as keyof typeof labels] ? '（不可用）' : ''}
            </option>
          ))}
        </ConfigurationSelect>
      </fieldset>
      <small>
        {readonly
          ? 'Sidechat 始终只读，不继承完整访问权限。'
          : state.permission === 'full-access'
            ? '可访问沙箱外文件和网络，通常不逐次请求批准。'
            : state.permission === 'auto-review'
              ? '保留工作区沙箱；越界请求由 Codex 自动审查，可能拒绝。'
              : '保留工作区沙箱；需要额外权限时由你批准。'}
      </small>
      <details>
        <summary>模式说明与兼容验证</summary>
        <small>
          计划模式先讨论与制定计划；切回执行模式后再提交实施要求。连接丽塔同学并启用语音控制后，可说“切换到计划模式”或“切换到执行模式”。
        </small>
        <ConfigurationButton
          type="button"
          disabled={verifying || !connected || !projectId}
          onClick={() => void verify()}
        >
          {verifying ? '正在验证…' : '验证执行设置'}
        </ConfigurationButton>
        {active?.verified.length ? (
          <p role="status">
            已由 Codex 确认：
            {active.verified
              .map((value) =>
                value === 'plan' ? '计划模式' : value === 'default' ? '执行模式' : labels[value],
              )
              .join('、')}
          </p>
        ) : (
          <small>验证会创建临时会话检查设置，不调用模型或修改项目。</small>
        )}
      </details>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
