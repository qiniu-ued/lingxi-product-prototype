import { randomUUID } from 'node:crypto';
import { type ThreadRuntime, workbenchSchema } from '@lingxi/protocol';
import { expect, type Page, test } from '@playwright/test';

const projectId = randomUUID(),
  conversationId = randomUUID();
const models = {
  projectId,
  data: [
    {
      id: 'one',
      model: 'test-model',
      displayName: 'Test Model',
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'medium', description: 'Balanced' },
        { reasoningEffort: 'high', description: 'Deep' },
      ],
    },
    {
      id: 'two',
      model: 'fast-model',
      displayName: 'Fast Model',
      isDefault: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }],
    },
  ],
};
const usage = {
  modelContextWindow: 128000,
  last: {
    totalTokens: 32000,
    inputTokens: 30000,
    cachedInputTokens: 12000,
    cacheWriteInputTokens: 1000,
    outputTokens: 2000,
    reasoningOutputTokens: 800,
  },
  total: {
    totalTokens: 150000,
    inputTokens: 140000,
    cachedInputTokens: 50000,
    cacheWriteInputTokens: 3000,
    outputTokens: 10000,
    reasoningOutputTokens: 3000,
  },
};
function runtime(): ThreadRuntime {
  return {
    conversationId,
    codexId: 'thread',
    model: 'test-model',
    effort: 'medium',
    configurationUpdatedAt: new Date().toISOString(),
    usage,
    usageTurnId: 'turn',
    usageUpdatedAt: new Date().toISOString(),
  };
}
async function open(page: Page, report: ThreadRuntime | null, failModels = false) {
  let state = workbenchSchema.parse({
    schemaVersion: 1,
    revision: 1,
    desktop: true,
    project: { id: projectId, name: 'Test', path: '/fixture' },
    task: null,
    preview: null,
    runtime: report,
    settings: { model: 'test-model', effort: 'high', plan: false },
  });
  await page.addInitScript(
    ({ snapshot }) => {
      Object.defineProperty(window, 'lingxiDesktop', { value: { onAudio: () => () => {} } });
      // Controlled SSE peer: keeps the connection open without real provider calls.
      Object.defineProperty(window, 'EventSource', {
        value: class {
          onopen?: () => void;
          listener?: (event: { data: string }) => void;
          timer: ReturnType<typeof setTimeout>;
          constructor() {
            this.timer = setTimeout(() => {
              this.onopen?.();
              this.listener?.({ data: snapshot });
            }, 10);
          }
          addEventListener(_name: string, listener: (event: { data: string }) => void) {
            this.listener = listener;
          }
          close() {
            clearTimeout(this.timer);
          }
        },
      });
    },
    { snapshot: JSON.stringify(state) },
  );
  await page.route('**/api/workbench/models', (route) => {
    return route.fulfill(
      failModels ? { status: 503, json: { error: 'unavailable' } } : { json: models },
    );
  });
  await page.route('**/api/workbench/workspace', async (route) => {
    const body = route.request().postDataJSON();
    state = { ...state, revision: state.revision + 1, settings: body.settings };
    await route.fulfill({ json: state });
  });
  await page.goto('/');
  return {
    state: () => state,
    allowModels: () => {
      failModels = false;
    },
  };
}
test('composer loads models automatically, limits effort choices and resets incompatible effort', async ({
  page,
}) => {
  const fixture = await open(page, runtime(), true);
  await expect(page.getByText('模型列表读取失败，已保存的选择仍保留。')).toBeVisible();
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('test-model');
  await expect(page.getByLabel('Reasoning Effort', { exact: true })).toHaveValue('high');
  fixture.allowModels();
  await page.getByRole('button', { name: '刷新模型列表' }).click();
  await page.getByLabel('模型', { exact: true }).selectOption('fast-model');
  await expect(page.getByLabel('Reasoning Effort', { exact: true })).toHaveValue('low');
  await expect(page.locator('#codex-effort option[value="high"]')).toHaveCount(0);
  expect(fixture.state().settings).toMatchObject({ model: 'fast-model', effort: 'low' });
});
test('context meter uses the last request, with separate cumulative and cached/reasoning counts', async ({
  page,
}) => {
  await open(page, runtime());
  const meter = page.getByRole('meter', { name: '上下文窗口占用', exact: true });
  await expect(meter).toHaveAttribute('aria-valuetext', '25.0% 已使用');
  await page.getByText('上下文使用详情', { exact: true }).click();
  const total = page.getByRole('row').filter({ hasText: '总 token' });
  await expect(total).toContainText('32,000');
  await expect(total).toContainText('150,000');
  await expect(page.getByRole('row').filter({ hasText: '缓存读取' })).toContainText('12,000');
  await expect(page.getByRole('row').filter({ hasText: '推理（输出内）' })).toContainText('800');
  await expect(page.getByText(/剩余 96,000 tokens/)).toBeVisible();
});
test('unknown usage or window capacity never appears as zero percent', async ({ page }) => {
  await open(page, { ...runtime(), usage: { ...usage, modelContextWindow: null } });
  await expect(page.getByRole('region', { name: '上下文用量' })).toContainText('容量未报告');
  await expect(page.getByRole('meter')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '上下文用量' })).not.toContainText('0.0%');
});

test('no usage report is shown as waiting rather than zero consumption', async ({ page }) => {
  await open(page, null);
  await expect(page.getByRole('region', { name: '上下文用量' })).toContainText(
    '等待 Codex 报告用量',
  );
  await expect(page.getByRole('meter')).toHaveCount(0);
});
