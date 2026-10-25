import {
  type ModelCatalog,
  modelCatalogSchema,
  reasoningEffortSchema,
  type WorkbenchState,
} from '@lingxi/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfigurationButton, ConfigurationSelect } from './ConfigurationControls.js';

export function ModelControls({
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
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const projectId = state.project?.id;
  const load = useCallback(async () => {
    controller.current?.abort();
    if (!projectId) {
      setCatalog(null);
      return;
    }
    const active = new AbortController();
    controller.current = active;
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/workbench/models', { signal: active.signal });
      if (!response.ok) throw new Error();
      const value = modelCatalogSchema.parse(await response.json());
      if (!active.signal.aborted && value.projectId === projectId) setCatalog(value);
    } catch {
      if (!active.signal.aborted) setError('模型列表读取失败，已保存的选择仍保留。');
    } finally {
      if (controller.current === active) setLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);
  const models = catalog && catalog.projectId === projectId ? catalog.data : [];
  const inherited = state.runtime?.model
    ? models.find((m) => m.model === state.runtime?.model)
    : models.find((m) => m.isDefault);
  const selected = state.settings.model
    ? models.find((m) => m.model === state.settings.model)
    : inherited;
  const efforts =
    selected?.supportedReasoningEfforts.flatMap((option) => {
      const parsed = reasoningEffortSchema.safeParse(option.reasoningEffort);
      return parsed.success ? [{ ...option, value: parsed.data }] : [];
    }) ?? [];
  const save = (model: string | null, effort: WorkbenchState['settings']['effort']) =>
    operate('workspace', { action: 'settings', settings: { ...state.settings, model, effort } });
  return (
    <section className="composer-models" aria-label="模型设置">
      <fieldset disabled={busy || !connected || !projectId}>
        <legend>用于新提交的轮次</legend>
        <label htmlFor="codex-model">模型</label>
        <ConfigurationSelect
          id="codex-model"
          disabled={busy || !connected || !projectId}
          value={state.settings.model ?? ''}
          onValueChange={(value) => {
            const model = value || null,
              descriptor = models.find((item) => item.model === model);
            const parsed = reasoningEffortSchema.safeParse(descriptor?.defaultReasoningEffort);
            const effort =
              parsed.success &&
              descriptor?.supportedReasoningEfforts.some((e) => e.reasoningEffort === parsed.data)
                ? parsed.data
                : null;
            void save(model, effort);
          }}
        >
          <option value="">
            {state.runtime?.model
              ? `沿用线程（${state.runtime.model}）`
              : inherited
                ? `Codex 默认（${inherited.displayName}）`
                : 'Codex 默认'}
          </option>
          {state.settings.model && !models.some((m) => m.model === state.settings.model) && (
            <option value={state.settings.model}>已保存：{state.settings.model}</option>
          )}
          {models.map((model) => (
            <option key={model.model} value={model.model}>
              {model.displayName}
            </option>
          ))}
        </ConfigurationSelect>
        <label htmlFor="codex-effort">Reasoning Effort</label>
        <ConfigurationSelect
          id="codex-effort"
          value={state.settings.effort ?? ''}
          disabled={busy || !connected || !projectId || !efforts.length}
          onValueChange={(value) => {
            const parsed = reasoningEffortSchema.safeParse(value);
            void save(state.settings.model, parsed.success ? parsed.data : null);
          }}
        >
          <option value="">沿用 Codex 设置</option>
          {state.settings.effort && !efforts.some((e) => e.value === state.settings.effort) && (
            <option value={state.settings.effort}>已保存：{state.settings.effort}</option>
          )}
          {efforts.map((effort) => (
            <option key={effort.value} value={effort.value} title={effort.description}>
              {effort.value}
              {selected?.defaultReasoningEffort === effort.value ? '（模型默认）' : ''}
            </option>
          ))}
        </ConfigurationSelect>
      </fieldset>
      <ConfigurationButton
        type="button"
        disabled={loading || !projectId}
        onClick={() => void load()}
      >
        {loading ? '读取模型中…' : '刷新模型列表'}
      </ConfigurationButton>
      {state.runtime?.model && (
        <small>
          Codex 已确认的线程设置：{state.runtime.model} · {state.runtime.effort ?? '强度未报告'}
        </small>
      )}
      <small>执行中的任务和已排队轮次保留提交时的选择。</small>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
