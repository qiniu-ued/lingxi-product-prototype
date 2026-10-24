import { randomUUID } from 'node:crypto';
import {
  type ThreadRuntime,
  taskSchema,
  type WorkbenchState,
  workbenchSchema,
} from '@lingxi/protocol';
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
async function open(
  page: Page,
  report: ThreadRuntime | null,
  failModels = false,
  extra: Partial<WorkbenchState> = {},
) {
  let state = workbenchSchema.parse({
    schemaVersion: 1,
    revision: 1,
    desktop: true,
    project: { id: projectId, name: 'Test', path: '/fixture' },
    task: null,
    preview: null,
    runtime: report,
    settings: { model: 'test-model', effort: 'high', plan: false },
    ...extra,
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
          broadcast = (event: Event) => this.listener?.({ data: (event as CustomEvent).detail });
          constructor() {
            window.addEventListener('fixture-snapshot', this.broadcast);
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
            window.removeEventListener('fixture-snapshot', this.broadcast);
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
    publish: async (change: Partial<WorkbenchState>) => {
      state = { ...state, ...change, revision: state.revision + 1 };
      await page.evaluate((snapshot) => {
        window.dispatchEvent(new CustomEvent('fixture-snapshot', { detail: snapshot }));
      }, JSON.stringify(state));
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

function turn(prompt: string, status = 'completed') {
  const now = new Date().toISOString();
  return taskSchema.parse({
    id: randomUUID(),
    projectId,
    conversationId,
    threadId: 'thread',
    turnId: prompt,
    prompt,
    status,
    messages: [{ id: 'answer', text: `${prompt}的回答` }],
    activity: 'done',
    approval: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
}
test('each completed turn shows its own tokens and input cache hit rate, including late SSE updates', async ({
  page,
}) => {
  const first = turn('第一轮'),
    second = turn('第二轮'),
    running = turn('运行中', 'running');
  const fixture = await open(page, runtime(), false, {
    history: [first, second, running],
    task: running,
    turnUsage: [{ taskId: first.id, status: 'reported', tokens: usage.last, updatedAt: null }],
  });
  const firstTurn = page.locator('article.conversation-turn').filter({ hasText: '第一轮' });
  const secondTurn = page.locator('article.conversation-turn').filter({ hasText: '第二轮' });
  await expect(firstTurn.getByRole('region', { name: '本轮 Token 用量' })).toContainText(
    '本轮 32,000 tokens',
  );
  await expect(firstTurn).toContainText('缓存命中率 40.0%');
  await expect(secondTurn).toContainText('本轮用量未报告');
  await expect(secondTurn).not.toContainText('本轮 0 tokens');
  await expect(
    page
      .locator('article.conversation-turn')
      .filter({ hasText: '运行中' })
      .getByRole('region', { name: '本轮 Token 用量' }),
  ).toHaveCount(0);
  await fixture.publish({
    turnUsage: [
      ...fixture.state().turnUsage,
      {
        taskId: second.id,
        status: 'reported',
        tokens: {
          ...usage.last,
          totalTokens: 48000,
          inputTokens: 40000,
          outputTokens: 8000,
          cachedInputTokens: 10000,
        },
        updatedAt: new Date().toISOString(),
      },
    ],
  });
  await expect(secondTurn).toContainText('本轮 48,000 tokens');
  await expect(secondTurn).toContainText('缓存命中率 25.0%');
  await expect(firstTurn).toContainText('缓存命中率 40.0%');
  await secondTurn.getByText('本轮用量明细', { exact: true }).click();
  await expect(secondTurn.getByRole('definition').first()).toHaveText('10,000');
});
test('missing baselines, cache counters and zero input do not invent cache hits', async ({
  page,
}) => {
  const missing = turn('缺少基线'),
    noCache = turn('缺少缓存'),
    zero = turn('无输入'),
    partial = turn('已中断', 'interrupted');
  await open(page, null, false, {
    history: [missing, noCache, zero, partial],
    turnUsage: [
      { taskId: missing.id, status: 'baseline-missing', tokens: null, updatedAt: null },
      {
        taskId: noCache.id,
        status: 'reported',
        tokens: { ...usage.last, cachedInputTokens: null },
        updatedAt: null,
      },
      {
        taskId: zero.id,
        status: 'reported',
        tokens: {
          ...usage.last,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
        },
        updatedAt: null,
      },
      { taskId: partial.id, status: 'reported', tokens: usage.last, updatedAt: null },
    ],
  });
  const article = (text: string) =>
    page.locator('article.conversation-turn').filter({ hasText: text });
  await expect(article('缺少基线')).toContainText('缺少起始累计值，无法计算本轮用量');
  await expect(article('缺少缓存')).toContainText('缓存命中率 未报告');
  await expect(article('无输入')).toContainText('缓存命中率 不适用（无输入）');
  await expect(article('已中断')).toContainText('截至最后报告的用量');
});
