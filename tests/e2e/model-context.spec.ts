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
    state = {
      ...state,
      revision: state.revision + 1,
      ...(body.action === 'set-permission'
        ? { permission: body.permission }
        : {
            settings:
              body.action === 'set-mode'
                ? { ...state.settings, plan: body.mode === 'plan' }
                : body.settings,
          }),
    };
    await route.fulfill({ json: state });
  });
  const execution = {
    projectId,
    plan: true,
    permissions: { manual: true, 'auto-review': true, 'full-access': true },
    verified: [] as string[],
  };
  await page.route('**/api/workbench/execution-options', (route) =>
    route.fulfill({ json: execution }),
  );
  await page.route('**/api/workbench/verify-execution', (route) =>
    route.fulfill({ json: { ...execution, verified: ['plan', 'default', 'manual'] } }),
  );
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
  await page.locator('.keyboard-composer > summary').click();
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
  await page.locator('.workbench-menu > summary').click();
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
  await page.locator('.workbench-menu > summary').click();
  await expect(page.getByRole('region', { name: '上下文用量' })).toContainText('容量未报告');
  await expect(page.getByRole('meter')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '上下文用量' })).not.toContainText('0.0%');
});

test('no usage report is shown as waiting rather than zero consumption', async ({ page }) => {
  await open(page, null);
  await page.locator('.workbench-menu > summary').click();
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
  const runningTurn = page.locator('article.conversation-turn').filter({ hasText: '运行中' });
  await firstTurn.locator('summary[aria-label="本轮详情"]').click();
  await secondTurn.locator('summary[aria-label="本轮详情"]').click();
  await runningTurn.locator('summary[aria-label="本轮详情"]').click();
  await expect(firstTurn.getByRole('region', { name: '本轮 Token 用量' })).toContainText(
    '本轮 32,000 tokens',
  );
  await expect(firstTurn).toContainText('缓存命中率 40.0%');
  await expect(secondTurn).toContainText('本轮用量未报告');
  await expect(secondTurn).not.toContainText('本轮 0 tokens');
  await expect(runningTurn.getByRole('region', { name: '本轮 Token 用量' })).toHaveCount(0);
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
  for (const prompt of ['缺少基线', '缺少缓存', '无输入', '已中断']) {
    await article(prompt).locator('summary[aria-label="本轮详情"]').click();
  }
  await expect(article('缺少基线')).toContainText('缺少起始累计值，无法计算本轮用量');
  await expect(article('缺少缓存')).toContainText('缓存命中率 未报告');
  await expect(article('无输入')).toContainText('缓存命中率 不适用（无输入）');
  await expect(article('已中断')).toContainText('截至最后报告的用量');
});
test('composer selects collaboration modes and permissions, and reports explicit verification', async ({
  page,
}) => {
  const fixture = await open(page, runtime());
  await page.locator('.keyboard-composer > summary').click();
  await expect(page.locator('#collaboration-mode option[value="plan"]')).toBeEnabled();
  await page.getByLabel('工作模式', { exact: true }).selectOption('plan');
  await expect(page.getByLabel('工作模式', { exact: true })).toHaveValue('plan');
  expect(fixture.state().settings.plan).toBe(true);
  await page.getByLabel('权限', { exact: true }).selectOption('full-access');
  await expect(page.getByRole('region', { name: '执行设置' })).toContainText(
    '可访问沙箱外文件和网络',
  );
  expect(fixture.state().permission).toBe('full-access');
  await page.getByLabel('权限', { exact: true }).selectOption('auto-review');
  await expect(page.getByRole('region', { name: '执行设置' })).toContainText(
    '越界请求由 Codex 自动审查',
  );
  await page.getByLabel('工作模式', { exact: true }).selectOption('default');
  await expect(page.getByLabel('工作模式', { exact: true })).toHaveValue('default');
  await page.getByText('模式说明与兼容验证', { exact: true }).click();
  await page.getByRole('button', { name: '验证执行设置', exact: true }).click();
  await expect(
    page.getByText('已由 Codex 确认：计划模式、执行模式、Manual · 手动审批'),
  ).toBeVisible();
  await expect(page.getByText('先给计划并请求确认', { exact: true })).toHaveCount(0);
});
test('tools show readable skill, MCP and quota cards with independent errors and no raw JSON', async ({
  page,
}) => {
  const fixture = await open(page, null);
  let catalog = {
    projectId,
    skills: {
      status: 'ready',
      items: [
        {
          name: 'review',
          displayName: '代码审阅',
          description: '检查修改并给出建议',
          enabled: true,
          scope: 'user',
          path: '/skills/review/SKILL.md',
        },
      ],
      issues: [],
    },
    mcp: {
      status: 'ready',
      items: [
        {
          name: '作品预览',
          runtimeStatus: 'connected',
          authStatus: 'oAuth',
          toolsUnavailable: false,
          tools: [{ name: 'click', description: '点击同一个作品页面' }],
          resourceCount: 0,
        },
      ],
    },
    limits: {
      status: 'ready',
      ordinaryUsageAllowed: false,
      buckets: [
        {
          id: 'codex',
          name: 'Codex',
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1800000000 },
          secondary: null,
          credits: null,
        },
      ],
    },
  };
  await page.route('**/api/workbench/catalog', (route) => route.fulfill({ json: catalog }));
  await page.locator('.workbench-menu > summary').click();
  await page.getByRole('button', { name: '工具与额度', exact: true }).click();
  await page.getByRole('button', { name: '读取 Skills、MCP 和账号额度' }).click();
  await expect(page.getByRole('region', { name: 'Skills', exact: true })).toContainText('代码审阅');
  await expect(page.getByRole('region', { name: 'Skills', exact: true })).toContainText('已启用');
  await expect(page.getByRole('region', { name: 'MCP', exact: true })).toContainText(
    '已连接 · 已登录',
  );
  await page.getByText('查看工具', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'MCP', exact: true })).toContainText(
    '点击同一个作品页面',
  );
  await expect(page.getByRole('progressbar', { name: '5 小时窗口' })).toHaveAttribute(
    'value',
    '20',
  );
  await expect(page.getByRole('region', { name: '账号额度', exact: true })).toContainText(
    '当前暂停普通额度',
  );
  await expect(page.locator('.workspace-tool pre')).toHaveCount(0);
  catalog = {
    ...catalog,
    skills: { status: 'unavailable', items: [], issues: [] },
    limits: { ...catalog.limits, buckets: [] },
  };
  await page.getByRole('button', { name: '刷新 Skills、MCP 和账号额度' }).click();
  await expect(page.getByRole('region', { name: 'Skills', exact: true })).toContainText(
    '技能列表暂不可用',
  );
  await expect(page.getByRole('region', { name: 'MCP', exact: true })).toContainText('已连接');
  await expect(page.getByRole('region', { name: '账号额度', exact: true })).toContainText(
    '尚未报告额度窗口',
  );
  expect(fixture.state().task).toBeNull();
});
