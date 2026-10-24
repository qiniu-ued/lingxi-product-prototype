import { randomUUID } from 'node:crypto';
import {
  type ThreadRuntime,
  taskSchema,
  voiceStateSchema,
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
      Object.defineProperty(window, 'lingxiDesktop', {
        value: {
          info: async () => ({ platform: 'darwin', arch: 'arm64', systemVersion: 'fixture' }),
          microphone: async () => {
            Reflect.set(
              window,
              'permissionRequests',
              (Reflect.get(window, 'permissionRequests') ?? 0) + 1,
            );
            return true;
          },
          microphoneStatus: async () =>
            Reflect.get(window, 'testMicrophonePermission') ?? 'granted',
          audioFrame: (pcm: ArrayBuffer) => {
            const values = new Int16Array(pcm);
            const frames = Reflect.get(window, 'inputFrames') ?? [];
            frames.push({
              at: performance.now(),
              max: values.reduce((n, v) => Math.max(n, Math.abs(v)), 0),
            });
            if (frames.length > 500) frames.shift();
            Reflect.set(window, 'inputFrames', frames);
          },
          onAudio: (listener: (value: unknown) => void) => {
            Reflect.set(window, 'voiceAudioListener', listener);
            return () => {
              if (Reflect.get(window, 'voiceAudioListener') === listener)
                Reflect.deleteProperty(window, 'voiceAudioListener');
            };
          },
          copy: async (text: string) => {
            Reflect.set(window, 'copiedReply', text);
          },
        },
      });
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
  await page.route('**/api/setup/check', (route) =>
    route.fulfill({
      json: {
        environment: {
          checkedAt: new Date().toISOString(),
          host: { platform: 'darwin', arch: 'arm64', nodeVersion: '24.11.0', nodeSupported: true },
          capabilities: { codexTasks: true, lingxiVoice: true },
        },
        codex: {
          checkedAt: new Date().toISOString(),
          status: 'ready',
          cliVersion: '0.999.0',
          authentication: 'chatgpt',
        },
        lingxi: {
          checkedAt: new Date().toISOString(),
          status: 'configured',
          reason: 'configuration-saved',
        },
        wake: { checkedAt: new Date().toISOString(), status: 'ready', reason: 'model-ready' },
        microphone: 'granted',
      },
    }),
  );
  await page.route('**/api/setup/codex/action', (route) =>
    route.fulfill({ json: { action: null } }),
  );
  await page.route('**/api/workbench/models', (route) => {
    return route.fulfill(
      failModels ? { status: 503, json: { error: 'unavailable' } } : { json: models },
    );
  });
  const commands: Array<Record<string, unknown>> = [];
  const contexts: Array<Record<string, unknown>> = [];
  await page.route('**/api/workbench/context', (route) => {
    contexts.push(route.request().postDataJSON());
    return route.fulfill({ json: state });
  });
  const views = new Map<
    string,
    Pick<WorkbenchState, 'history' | 'task' | 'runtime' | 'turnUsage'>
  >();
  await page.route('**/api/workbench/workspace', async (route) => {
    const body = route.request().postDataJSON();
    commands.push(body);
    if (body.action === 'fork') {
      if (state.selectedThreadId)
        views.set(state.selectedThreadId, {
          history: state.history,
          task: state.task,
          runtime: state.runtime,
          turnUsage: state.turnUsage,
        });
      const id = randomUUID();
      state = {
        ...state,
        revision: state.revision + 1,
        threads: [
          ...state.threads,
          {
            id,
            projectId,
            codexId: 'sidechat',
            title: '选段讨论',
            kind: 'sidechat',
            parentId: state.selectedThreadId,
            archived: false,
            createdAt: new Date().toISOString(),
          },
        ],
        selectedThreadId: id,
        history: [],
        task: null,
        runtime: null,
        turnUsage: [],
      };
      await route.fulfill({ json: state });
      return;
    }
    if (body.action === 'select-thread') {
      if (state.selectedThreadId)
        views.set(state.selectedThreadId, {
          history: state.history,
          task: state.task,
          runtime: state.runtime,
          turnUsage: state.turnUsage,
        });
      state = {
        ...state,
        ...views.get(body.id),
        selectedThreadId: body.id,
        revision: state.revision + 1,
      };
      await route.fulfill({ json: state });
      return;
    }
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
  let voice = voiceStateSchema.parse({
    configured: false,
    status: 'disconnected',
    draft: '',
    captureId: null,
    subtitle: '',
    error: null,
    allowVoiceSubmit: false,
  });
  await page.route('**/api/voice', (route) => route.fulfill({ json: voice }));
  await page.route('**/api/voice/inspect', (route) => route.fulfill({ json: voice }));
  const voiceCommands: Array<Record<string, unknown>> = [];
  await page.route('**/api/voice/preferences', (route) => {
    const body = route.request().postDataJSON();
    voiceCommands.push({ action: 'preferences', ...body });
    voice = {
      ...voice,
      allowVoiceSubmit: body.allowVoiceSubmit,
      status: 'disconnected',
      deviceToolsReady: false,
    };
    return route.fulfill({ json: voice });
  });
  await page.route('**/api/voice/command', (route) => {
    const body = route.request().postDataJSON();
    voiceCommands.push(body);
    if (body.action === 'wake-auto') {
      voice = {
        ...voice,
        wakePreference: { version: 1, enabled: body.enabled, source: 'user' },
        wakeAutoSuspended: !body.enabled,
        ...(!body.enabled
          ? { conversationActive: false, wake: { ...voice.wake, status: 'off', detectionId: null } }
          : { wake: { ...voice.wake, status: 'off', error: null } }),
      };
    }
    if (body.action === 'pause-voice')
      voice = {
        ...voice,
        conversationActive: false,
        speechId: null,
        status: voice.status === 'disconnected' ? 'disconnected' : 'ready',
        wakeAutoSuspended: voice.wakeAutoSuspended || (body.suspend ?? true),
        wake: { ...voice.wake, status: 'off', detectionId: null },
      };
    if (body.action === 'dismiss-wake')
      voice = { ...voice, wake: { ...voice.wake, status: 'armed', detectionId: null } };
    if (body.action === 'connect')
      voice = {
        ...voice,
        status: 'ready',
        error: null,
        connectionPreference: { version: 1, enabled: true, source: 'user' },
      };
    if (body.action === 'connection-auto')
      voice = {
        ...voice,
        status: body.enabled && voice.configured ? 'ready' : 'disconnected',
        connectionPreference: { version: 1, enabled: body.enabled, source: 'user' },
      };
    if (body.action === 'disconnect')
      voice = {
        ...voice,
        status: 'disconnected',
        deviceToolsReady: false,
        connectionPreference: { version: 1, enabled: false, source: 'user' },
      };
    if (body.action === 'install-wake')
      voice = { ...voice, wake: { ...voice.wake, installed: true, status: 'off' } };
    if (body.action === 'arm-wake')
      voice = { ...voice, wake: { ...voice.wake, keyword: body.keyword, status: 'armed' } };
    if (body.action === 'listen')
      voice = {
        ...voice,
        status: 'listening',
        conversationActive: true,
        speechId: null,
        captureId: randomUUID(),
      };
    if (body.action === 'start-session')
      voice = { ...voice, conversationActive: true, speechId: null, status: 'ready' };
    if (body.action === 'stop-session')
      voice = {
        ...voice,
        wakePreference: { version: 1, enabled: false, source: 'user' },
        wakeAutoSuspended: true,
        connectionPreference: { version: 1, enabled: false, source: 'user' },
        conversationActive: false,
        speechId: null,
        status: 'disconnected',
        wake: { ...voice.wake, status: 'off' },
      };
    if (body.action === 'stop-wake')
      voice = {
        ...voice,
        status: 'ready',
        conversationActive: false,
        wake: { ...voice.wake, status: 'off', detectionId: null },
      };
    if (body.action === 'wake-keyword')
      voice = { ...voice, wake: { ...voice.wake, keyword: body.keyword } };
    if (body.action === 'context-details') voice = { ...voice, contextDetailsOpen: body.open };
    return route.fulfill({ json: voice });
  });
  await page.goto('/');
  return {
    commands,
    voiceCommands,
    contexts,
    publishVoice: (change: Partial<typeof voice>) => {
      voice = { ...voice, ...change };
    },
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

function historyThread() {
  return {
    id: conversationId,
    projectId,
    codexId: 'thread',
    title: '主对话',
    kind: 'main' as const,
    parentId: null,
    archived: false,
    createdAt: new Date().toISOString(),
  };
}
async function selectExcerpt(page: Page, taskId: string, text: string, role = 'assistant') {
  const bubble = page
    .locator(`[data-history-task="${taskId}"][data-history-role="${role}"]`)
    .first();
  await bubble.scrollIntoViewIfNeeded();
  await bubble.evaluate((element, excerpt) => {
    const node = element.firstChild;
    const start = node?.textContent?.indexOf(excerpt) ?? -1;
    if (!node || start < 0) throw new Error('Missing excerpt');
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + excerpt.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, text);
  await expect(page.getByRole('toolbar', { name: '所选对话文字操作' })).toBeVisible();
}
test('selecting an excerpt quotes only that text and preserves a written reply without starting a task', async ({
  page,
}) => {
  const source = turn('原始要求');
  source.messages = [
    { id: 'answer', text: '第一段介绍。\n这一段需要重新设计。\n最后一段保持不变。' },
  ];
  const fixture = await open(page, runtime(), false, {
    threads: [historyThread()],
    selectedThreadId: conversationId,
    history: [source],
    task: source,
  });
  await page.locator('.keyboard-composer > summary').click();
  await page.getByLabel('给 Codex 的本轮指令').fill('请解释这里的设计考虑');
  await selectExcerpt(page, source.id, '这一段需要重新设计。');
  await page.getByRole('button', { name: '引用到对话', exact: true }).click();
  await expect(page.getByLabel('给 Codex 的本轮指令')).toHaveValue('请解释这里的设计考虑');
  await expect(page.locator('.context-attachments')).toContainText('这一段需要重新设计。');
  await expect(page.locator('.context-attachments')).not.toContainText('最后一段');
  await expect(page.getByLabel('给 Codex 的本轮指令')).toBeFocused();
  expect(fixture.commands).toHaveLength(0);
});
test('excerpt Sidechat stages a quote and keeps both conversation drafts when returning with a result', async ({
  page,
}) => {
  const source = turn('保留主对话草稿');
  source.messages = [{ id: 'answer', text: '请讨论这个按钮。其他内容不选中。' }];
  const fixture = await open(page, runtime(), false, {
    threads: [historyThread()],
    selectedThreadId: conversationId,
    history: [source],
    task: source,
  });
  await page.locator('.keyboard-composer > summary').click();
  await page.getByLabel('给 Codex 的本轮指令').fill('主对话未发送的草稿');
  await selectExcerpt(page, source.id, '请讨论这个按钮。');
  await page.getByRole('button', { name: '选段 Sidechat', exact: true }).click();
  await expect(page.getByLabel('权限', { exact: true })).toHaveValue('sidechat');
  await expect(page.getByLabel('给 Codex 的本轮指令')).toHaveValue('');
  await expect(page.locator('.context-attachments')).toContainText('请讨论这个按钮。');
  await expect(page.locator('.context-attachments')).not.toContainText('其他内容');
  expect(fixture.commands[0]).toMatchObject({
    action: 'fork',
    taskId: source.id,
    kind: 'sidechat',
    quote: { role: 'assistant', messageId: 'answer', text: '请讨论这个按钮。' },
  });
  expect(fixture.state().task).toBeNull();
  await page.getByLabel('给 Codex 的本轮指令').fill('Sidechat 的问题草稿');
  const sideId = fixture.state().selectedThreadId as string;
  const answer = {
    ...turn('讨论按钮'),
    conversationId: sideId,
    threadId: 'sidechat',
    messages: [{ id: 'response', text: '讨论结论：保留这个按钮。' }],
  };
  await fixture.publish({ history: [answer], task: answer });
  await page.locator('.keyboard-composer > summary').click();
  await selectExcerpt(page, answer.id, '讨论结论：保留这个按钮。');
  await page.getByRole('button', { name: '引用到原对话' }).click();
  await expect(page.getByLabel('给 Codex 的本轮指令')).toHaveValue('主对话未发送的草稿');
  await expect(page.locator('.context-attachments')).toContainText('讨论结论：保留这个按钮。');
  await page.locator('.workbench-menu > summary').click();
  await page.getByLabel('切换对话').selectOption(sideId);
  await page.locator('.workbench-menu > summary').click();
  await expect(page.getByLabel('给 Codex 的本轮指令')).toHaveValue('Sidechat 的问题草稿');
  await expect(page.locator('.context-attachments')).toContainText('请讨论这个按钮。');
});
test('usage summaries remain visible with auxiliary menus closed, including on the passive display', async ({
  page,
}) => {
  const source = turn('查看统计');
  await open(page, runtime(), false, {
    threads: [historyThread()],
    selectedThreadId: conversationId,
    history: [source],
    task: source,
    turnUsage: [{ taskId: source.id, status: 'reported', tokens: usage.last, updatedAt: null }],
  });
  for (const path of ['/', '/display']) {
    if (path !== '/') await page.goto(path);
    await expect(page.getByRole('region', { name: '本轮用量摘要' })).toContainText(
      '32,000 Token used',
    );
    await expect(page.getByRole('region', { name: '本轮用量摘要' })).toContainText(
      '40.0% Cache hit.',
    );
    await expect(page.getByRole('table')).toHaveCount(0);
    await page.getByRole('button', { name: '上下文使用详情', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Context Window: 32,000/128,000 used.');
    await expect(page.getByRole('meter', { name: '当前上下文占用', exact: true })).toHaveAttribute(
      'aria-valuetext',
      '25.0% 已使用',
    );
  }
});
test('context meter uses the last request, with separate cumulative and cached/reasoning counts', async ({
  page,
}) => {
  await open(page, runtime());
  const meter = page.getByRole('meter', { name: '当前上下文占用', exact: true });
  await expect(meter).toHaveAttribute('aria-valuetext', '25.0% 已使用');
  await page.getByRole('button', { name: '上下文使用详情', exact: true }).click();
  const total = page.getByRole('row').filter({ hasText: '总 token' });
  await expect(total).toContainText('32,000');
  await expect(total).toContainText('150,000');
  await expect(page.getByRole('row').filter({ hasText: '缓存读取' })).toContainText('12,000');
  await expect(page.getByRole('row').filter({ hasText: '推理（输出内）' })).toContainText('800');
  await expect(
    page.getByRole('region', { name: '上下文用量', exact: true }).getByText(/剩余 96,000 tokens/),
  ).toBeVisible();
});
test('unknown usage or window capacity never appears as zero percent', async ({ page }) => {
  await open(page, { ...runtime(), usage: { ...usage, modelContextWindow: null } });
  await page.getByRole('button', { name: '上下文使用详情', exact: true }).click();
  await expect(page.getByRole('region', { name: '上下文用量' })).toContainText('容量未报告');
  await expect(page.getByRole('meter')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '上下文用量' })).not.toContainText('0.0%');
});

test('no usage report is shown as waiting rather than zero consumption', async ({ page }) => {
  await open(page, null);
  await page.getByRole('button', { name: '上下文使用详情', exact: true }).click();
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
  await expect(firstTurn.getByRole('region', { name: '本轮用量摘要' })).toContainText(
    '32,000 Token used',
  );
  await expect(firstTurn).toContainText('40.0% Cache hit.');
  await expect(secondTurn.locator('.turn-usage')).toHaveCount(0);
  await expect(secondTurn).not.toContainText('本轮 0 tokens');
  await expect(runningTurn.getByRole('region', { name: '本轮用量摘要' })).toHaveCount(0);
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
  await expect(secondTurn).toContainText('48,000 Token used');
  await expect(secondTurn).toContainText('25.0% Cache hit.');
  await expect(firstTurn).toContainText('40.0% Cache hit.');
  await expect(secondTurn.locator('.turn-usage')).toHaveText(
    '48,000 Token used, 40,000 Input, 8,000 Output, 25.0% Cache hit.',
  );
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
  await expect(article('缺少基线').locator('.turn-usage')).toHaveCount(0);
  await expect(article('缺少缓存').locator('.turn-usage')).toContainText('32,000 Token used');
  await expect(article('缺少缓存').locator('.turn-usage')).not.toContainText('Cache hit');
  await expect(article('无输入').locator('.turn-usage')).toHaveText(
    '0 Token used, 0 Input, 0 Output.',
  );
  await expect(article('已中断').locator('.turn-usage')).toContainText('40.0% Cache hit.');
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

test('voice wake uses the real audio worklet, stages current drafts after detection, and releases tracks when disabled', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const context = new AudioContext({ sampleRate: 16000 });
        const source = context.createConstantSource();
        source.offset.value = 0.05;
        const output = context.createMediaStreamDestination();
        source.connect(output);
        source.start();
        await context.resume();
        Reflect.set(window, 'testMicTracks', output.stream.getTracks());
        return output.stream;
      },
    });
  });
  const fixture = await open(page, runtime(), false, {
    threads: [historyThread()],
    selectedThreadId: conversationId,
  });
  fixture.publishVoice({
    configured: true,
    status: 'ready',
    wake: { status: 'off', keyword: '丽塔同学', installed: true, detectionId: null, error: null },
  });
  await page.locator('.keyboard-composer > summary').click();
  await page.getByLabel('给 Codex 的本轮指令').fill('本轮待发送草稿');
  await page.getByText('语音唤醒', { exact: true }).click();
  await page.getByRole('button', { name: '启用自动唤醒', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '本地待唤醒' })).toContainText(
    '丽塔同学',
  );
  expect(fixture.contexts).toHaveLength(0);
  expect(fixture.voiceCommands.some((command) => command.action === 'listen')).toBe(false);
  fixture.publishVoice({
    wake: {
      status: 'detected',
      keyword: '丽塔同学',
      installed: true,
      detectionId: randomUUID(),
      error: null,
    },
  });
  await expect.poll(() => fixture.contexts.length).toBe(1);
  expect(fixture.contexts[0]).toMatchObject({ projectId, conversationId, text: '本轮待发送草稿' });
  await expect
    .poll(() => fixture.voiceCommands.filter((command) => command.action === 'listen').length)
    .toBe(1);
  await page.getByRole('button', { name: '关闭语音唤醒', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Reflect.get(window, 'testMicTracks') as MediaStreamTrack[]).every(
          (track) => track.readyState === 'ended',
        ),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: '启用自动唤醒', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '本地待唤醒' })).toBeVisible();
  const arms = fixture.voiceCommands.filter((command) => command.action === 'arm-wake').length;
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '配置与连接', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Reflect.get(window, 'testMicTracks') as MediaStreamTrack[]).every(
          (track) => track.readyState === 'ended',
        ),
      ),
    )
    .toBe(true);
  await expect
    .poll(() => fixture.voiceCommands.filter((command) => command.action === 'pause-voice').length)
    .toBe(1);
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '本地待唤醒' })).toBeVisible();
  expect(fixture.voiceCommands.filter((command) => command.action === 'arm-wake')).toHaveLength(
    arms + 1,
  );
  await expect(page.getByLabel('给 Codex 的本轮指令')).toHaveValue('本轮待发送草稿');
});
test('an explicit voice conversation keeps its microphone through responses and stops only on close or a real connection failure', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const context = new AudioContext({ sampleRate: 16000 });
        const source = context.createConstantSource();
        const output = context.createMediaStreamDestination();
        source.connect(output);
        source.start();
        await context.resume();
        Reflect.set(window, 'conversationTracks', output.stream.getTracks());
        return output.stream;
      },
    });
  });
  const fixture = await open(page, runtime(), false, {
    threads: [historyThread()],
    selectedThreadId: conversationId,
  });
  fixture.publishVoice({ configured: true, status: 'ready' });
  await page.locator('.keyboard-composer > summary').click();
  await page.getByLabel('给 Codex 的本轮指令').fill('第一句话的草稿');
  await page.getByRole('button', { name: '开始收音', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '本机待说话' })).toBeVisible();
  expect(fixture.contexts).toHaveLength(1);
  expect(fixture.contexts[0]).toMatchObject({
    projectId,
    conversationId,
    text: '第一句话的草稿',
  });
  fixture.publishVoice({ speechId: randomUUID() });
  await expect.poll(() => fixture.contexts.length).toBe(2);
  fixture.publishVoice({ status: 'processing' });
  await expect(page.getByRole('status').filter({ hasText: '会话保持开启' })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (Reflect.get(window, 'conversationTracks') as MediaStreamTrack[]).every(
        (track) => track.readyState === 'live',
      ),
    ),
  ).toBe(true);
  fixture.publishVoice({ status: 'speaking' });
  await expect(page.getByRole('status').filter({ hasText: '正在播报' })).toBeVisible();
  fixture.publishVoice({ status: 'ready', speechId: null });
  await expect(page.getByRole('status').filter({ hasText: '本机待说话' })).toBeVisible();
  await page.getByLabel('给 Codex 的本轮指令').fill('第二句话的新草稿');
  fixture.publishVoice({ speechId: randomUUID() });
  await expect.poll(() => fixture.contexts.length).toBe(3);
  expect(fixture.contexts[2]).toMatchObject({ text: '第二句话的新草稿' });
  await page.getByRole('button', { name: '关闭语音', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Reflect.get(window, 'conversationTracks') as MediaStreamTrack[]).every(
          (track) => track.readyState === 'ended',
        ),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: '连接丽塔同学', exact: true }).click();
  await page.getByRole('button', { name: '开始收音', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '本机待说话' })).toBeVisible();
  fixture.publishVoice({
    status: 'failed',
    conversationActive: false,
    error: '连接已断开，请重新连接。',
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Reflect.get(window, 'conversationTracks') as MediaStreamTrack[]).every(
          (track) => track.readyState === 'ended',
        ),
      ),
    )
    .toBe(true);
  fixture.publishVoice({ status: 'ready', error: null });
  await expect(page.getByRole('button', { name: '开始收音', exact: true })).toBeEnabled();
  expect(
    fixture.voiceCommands.filter((command) => command.action === 'start-session'),
  ).toHaveLength(2);
  expect(fixture.commands).toHaveLength(0);
});
test('opening settings while microphone acquisition is pending releases the late stream without starting capture', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const context = new AudioContext({ sampleRate: 16000 });
        const output = context.createMediaStreamDestination();
        Reflect.set(window, 'lateMicTracks', output.stream.getTracks());
        await new Promise<void>((resolve) => Reflect.set(window, 'releaseMic', resolve));
        return output.stream;
      },
    });
  });
  const fixture = await open(page, runtime());
  fixture.publishVoice({ configured: true, status: 'ready' });
  await page.getByRole('button', { name: '开始收音', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof Reflect.get(window, 'releaseMic')))
    .toBe('function');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '配置与连接', exact: true })).toBeVisible();
  await page.evaluate(() => Reflect.get(window, 'releaseMic')());
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Reflect.get(window, 'lateMicTracks') as MediaStreamTrack[]).every(
          (track) => track.readyState === 'ended',
        ),
      ),
    )
    .toBe(true);
  expect(fixture.contexts).toEqual([
    { projectId, conversationId: null, text: '', attachments: [], selection: null },
  ]);
  expect(fixture.voiceCommands.some((command) => command.action === 'listen')).toBe(false);
  expect(fixture.commands).toHaveLength(0);
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始收音', exact: true })).toBeEnabled();
});
test('copy and Fork remain as icons while quotes and Sidechat require a text selection; voice opens details on both screens', async ({
  page,
}) => {
  const source = turn('测试入口');
  const fixture = await open(page, runtime(), false, {
    threads: [historyThread()],
    selectedThreadId: conversationId,
    history: [source],
    task: source,
  });
  await expect(page.getByRole('button', { name: '添加到对话', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sidechat', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Fork 对话', exact: true })).toHaveText('');
  await page.getByRole('button', { name: '复制本轮回复', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'copiedReply'))).toBe('测试入口的回答');
  fixture.publishVoice({ contextDetailsOpen: true });
  await expect(page.getByRole('button', { name: '上下文使用详情', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.getByRole('table')).toBeVisible();
  await page.goto('/display');
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: '上下文使用详情', exact: true }).click();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('permanent settings keep the active composer and manage voice consent and the session wake keyword', async ({
  page,
}) => {
  const source = turn('保留设置前的工作');
  const fixture = await open(page, runtime(), false, {
    threads: [historyThread()],
    selectedThreadId: conversationId,
    history: [source],
    task: source,
  });
  fixture.publishVoice({
    configured: true,
    status: 'ready',
    wake: { status: 'off', keyword: '丽塔同学', installed: true, detectionId: null, error: null },
  });
  await page.locator('.keyboard-composer > summary').click();
  await page.getByLabel('给 Codex 的本轮指令').fill('设置前没有发送的草稿');
  await selectExcerpt(page, source.id, '保留设置前的工作的回答');
  await page.getByRole('button', { name: '引用到对话', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: '配置与连接', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: /丽塔同学与语音执行/ })
    .click();
  const consent = page.getByRole('checkbox', { name: /允许主动收音后用语音提交/ });
  await expect(consent).not.toBeChecked();
  await consent.click();
  await expect(consent).toBeChecked();
  await expect(page.getByRole('region', { name: '语音交接状态' })).toContainText('语音执行已开启');
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: /语音唤醒与麦克风/ })
    .click();
  await page.getByLabel('本次运行的唤醒词').fill('你好同学');
  await page.getByRole('button', { name: '保存本次唤醒词', exact: true }).click();
  await expect
    .poll(() =>
      fixture.voiceCommands.some(
        (command) => command.action === 'wake-keyword' && command.keyword === '你好同学',
      ),
    )
    .toBe(true);
  await expect(page.getByLabel('本次运行的唤醒词')).toHaveValue('你好同学');
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(page.getByLabel('给 Codex 的本轮指令')).toHaveValue('设置前没有发送的草稿');
  await expect(page.locator('.context-attachments')).toContainText('保留设置前的工作的回答');
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '配置与连接', exact: true })).toBeVisible();
    if (cycle === 0) {
      await page.goBack();
    } else {
      await page.getByRole('button', { name: '连接向导', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: '先检查，再配置。', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await expect(page.getByRole('heading', { name: '配置与连接', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '返回工作台', exact: true }).click();
    }
    await expect(page.getByLabel('给 Codex 的本轮指令')).toHaveValue('设置前没有发送的草稿');
    await expect(page.locator('.context-attachments')).toContainText('保留设置前的工作的回答');
  }
  expect(fixture.commands).toHaveLength(0);
  expect(
    fixture.voiceCommands.some(
      (command) => command.action === 'listen' || command.action === 'arm-wake',
    ),
  ).toBe(false);
});
test('voice connection failure can be retried and disconnected in settings without microphone capture or task submission', async ({
  page,
}) => {
  const fixture = await open(page, runtime());
  fixture.publishVoice({ configured: true, status: 'disconnected', allowVoiceSubmit: false });
  let fail = true;
  await page.route('**/api/voice/command', (route) => {
    if (route.request().postDataJSON().action === 'connect' && fail) {
      fail = false;
      return route.fulfill({ status: 503, json: { error: 'PRIVATE_PROVIDER_ERROR' } });
    }
    return route.fallback();
  });
  await page.getByRole('button', { name: '连接丽塔同学', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('操作未完成');
  await expect(page.getByRole('alert')).not.toContainText('PRIVATE_PROVIDER_ERROR');
  await page.getByRole('button', { name: '连接丽塔同学', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '待唤醒 · 麦克风已关闭' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: /丽塔同学与语音执行/ })
    .click();
  await expect(page.getByRole('checkbox', { name: /允许主动收音后用语音提交/ })).not.toBeChecked();
  await page.getByRole('button', { name: '断开语音服务', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '语音未连接' })).toBeVisible();
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(page.getByRole('button', { name: '连接丽塔同学', exact: true })).toBeEnabled();
  expect(
    fixture.voiceCommands.some(
      (command) => command.action === 'listen' || command.action === 'arm-wake',
    ),
  ).toBe(false);
  expect(fixture.commands).toHaveLength(0);
  expect(fixture.contexts).toHaveLength(0);
});
test('voice handoff distinguishes draft-only, unhandled voice replies and accepted tasks on both screens', async ({
  page,
}) => {
  const fixture = await open(page, runtime(), false, {
    threads: [historyThread()],
    selectedThreadId: conversationId,
  });
  fixture.publishVoice({ configured: true, status: 'ready', allowVoiceSubmit: false });
  const handoff = page.getByRole('region', { name: '语音交接状态', exact: true });
  await expect(handoff).toContainText('仅转写草稿');
  fixture.publishVoice({
    allowVoiceSubmit: true,
    deviceToolsReady: true,
    handoff: {
      captureId: randomUUID(),
      status: 'unhandled',
      taskId: null,
      message: '丽塔同学本轮没有提交给 Codex。请检查云端智能体的工具调用配置，或使用转写草稿提交。',
    },
  });
  await expect(handoff).toContainText('没有提交给 Codex');
  await expect(page.locator('article.conversation-turn')).toHaveCount(0);
  const task = turn('把这个页面变成粉色', 'running');
  await fixture.publish({ history: [task], task });
  fixture.publishVoice({
    handoff: {
      captureId: task.id,
      status: 'submitted',
      taskId: task.id,
      message: '已交给 Codex，进度与回复在右侧对话中显示。',
    },
  });
  await expect(handoff).toContainText(task.id.slice(0, 8));
  await page.goto('/display');
  await expect(page.getByRole('region', { name: '语音交接状态' })).toContainText('已交给 Codex');
  await expect(page.getByRole('button', { name: '设置', exact: true })).toHaveCount(0);
});

async function syntheticMicrophone(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async (constraints: MediaStreamConstraints) => {
        Reflect.set(window, 'requestedAudioConstraints', constraints);
        Reflect.set(window, 'mediaRequests', (Reflect.get(window, 'mediaRequests') ?? 0) + 1);
        const context = new AudioContext({ sampleRate: 16000 });
        const source = context.createConstantSource();
        source.offset.value = 0.05;
        const output = context.createMediaStreamDestination();
        source.connect(output);
        source.start();
        await context.resume();
        Reflect.set(window, 'syntheticTracks', output.stream.getTracks());
        return output.stream;
      },
    });
  });
}
const defaultWake = { version: 1 as const, enabled: true, source: 'default' as const };
const installedWake = {
  status: 'off' as const,
  keyword: '丽塔同学',
  installed: true,
  detectionId: null,
  error: null,
};

test('default wake and an existing service connection stay separate; only a wake stages capture, and explicit off survives restart', async ({
  page,
}) => {
  await syntheticMicrophone(page);
  const f = await open(page, runtime(), false, {
    threads: [historyThread()],
    selectedThreadId: conversationId,
  });
  f.publishVoice({
    configured: true,
    status: 'ready',
    connectionPreference: defaultWake,
    wakePreference: defaultWake,
    wake: installedWake,
  });
  await expect(page.getByRole('status').filter({ hasText: '本地待唤醒' })).toBeVisible();
  expect(f.voiceCommands.filter((c) => c.action === 'arm-wake')).toHaveLength(1);
  expect(
    f.voiceCommands.some((c) => ['connect', 'listen', 'start-session'].includes(String(c.action))),
  ).toBe(false);
  expect(await page.evaluate(() => Reflect.get(window, 'permissionRequests'))).toBeUndefined();
  expect(await page.evaluate(() => Reflect.get(window, 'requestedAudioConstraints'))).toMatchObject(
    {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    },
  );
  f.publishVoice({ wake: { ...installedWake, status: 'detected', detectionId: randomUUID() } });
  await expect.poll(() => f.voiceCommands.filter((c) => c.action === 'listen').length).toBe(1);
  expect(f.voiceCommands.filter((c) => c.action === 'connect')).toHaveLength(0);
  expect(f.contexts).toHaveLength(1);
  await page.getByRole('button', { name: '关闭语音', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Reflect.get(window, 'syntheticTracks') as MediaStreamTrack[]).every(
          (t) => t.readyState === 'ended',
        ),
      ),
    )
    .toBe(true);
  await page.reload();
  await page.getByText('语音唤醒', { exact: true }).click();
  await expect(page.getByRole('button', { name: '启用自动唤醒', exact: true })).toBeVisible();
  expect(f.voiceCommands.filter((c) => c.action === 'arm-wake')).toHaveLength(1);
});

test('an enabled preference starts again on a fresh authorized app session without another toggle', async ({
  page,
}) => {
  await syntheticMicrophone(page);
  const f = await open(page, runtime());
  f.publishVoice({ wakePreference: defaultWake, wake: installedWake });
  await expect(page.getByRole('status').filter({ hasText: '本地待唤醒' })).toBeVisible();
  await expect.poll(() => f.voiceCommands.filter((c) => c.action === 'arm-wake').length).toBe(1);
  // Simulate the fresh service state after application restart; preference remains enabled.
  f.publishVoice({ status: 'disconnected', wake: installedWake, wakeAutoSuspended: false });
  await page.reload();
  await expect.poll(() => f.voiceCommands.filter((c) => c.action === 'arm-wake').length).toBe(2);
  expect(await page.evaluate(() => Reflect.get(window, 'permissionRequests'))).toBeUndefined();
});

for (const permission of ['denied', 'not-determined']) {
  test(`default wake guides ${permission} authorization without requesting access or media`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => Reflect.set(window, 'testMicrophonePermission', value),
      permission,
    );
    await syntheticMicrophone(page);
    const f = await open(page, runtime());
    f.publishVoice({ wakePreference: defaultWake, wake: installedWake });
    await expect(page.getByRole('status').filter({ hasText: '自动唤醒待授权' })).toBeVisible();
    await expect(page.getByRole('button', { name: '配置默认唤醒', exact: true })).toBeVisible();
    expect(f.voiceCommands).toHaveLength(0);
    expect(await page.evaluate(() => Reflect.get(window, 'mediaRequests'))).toBeUndefined();
    expect(await page.evaluate(() => Reflect.get(window, 'permissionRequests'))).toBeUndefined();
  });
}

test('default wake waits for a missing model and stops when microphone authorization is revoked', async ({
  page,
}) => {
  await syntheticMicrophone(page);
  const f = await open(page, runtime());
  f.publishVoice({ wakePreference: defaultWake });
  await expect(page.getByRole('button', { name: '配置默认唤醒', exact: true })).toBeVisible();
  expect(f.voiceCommands).toHaveLength(0);
  f.publishVoice({ wake: installedWake });
  await expect(page.getByRole('status').filter({ hasText: '本地待唤醒' })).toBeVisible();
  await page.evaluate(() => Reflect.set(window, 'testMicrophonePermission', 'denied'));
  await expect(page.getByRole('alert').filter({ hasText: '麦克风权限已撤销' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Reflect.get(window, 'syntheticTracks') as MediaStreamTrack[]).every(
          (t) => t.readyState === 'ended',
        ),
      ),
    )
    .toBe(true);
  expect(f.voiceCommands.filter((c) => c.action === 'arm-wake')).toHaveLength(1);
});

test('own TTS and its short echo tail mute outgoing microphone frames, then normal input resumes', async ({
  page,
}) => {
  await syntheticMicrophone(page);
  const f = await open(page, runtime());
  f.publishVoice({ configured: true, status: 'ready' });
  await page.getByRole('button', { name: '开始收音', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (Reflect.get(window, 'inputFrames') ?? []).filter(
            (frame: { max: number }) => frame.max > 0,
          ).length,
      ),
    )
    .toBeGreaterThan(5);
  const end = await page.evaluate(() => {
    const pcm = new Int16Array(4000).fill(5000);
    const bytes = new Uint8Array(pcm.buffer);
    Reflect.get(
      window,
      'voiceAudioListener',
    )({ pcm: btoa(String.fromCharCode(...bytes)), sampleRate: 16000 });
    return performance.now() + 280;
  });
  await expect
    .poll(() =>
      page.evaluate(
        (after) =>
          (Reflect.get(window, 'inputFrames') ?? []).some(
            (frame: { at: number; max: number }) => frame.at > after + 700 && frame.max > 0,
          ),
        end,
      ),
    )
    .toBe(true);
  const tail = await page.evaluate(
    (after) =>
      (Reflect.get(window, 'inputFrames') ?? []).filter(
        (frame: { at: number }) => frame.at > after + 50 && frame.at < after + 450,
      ),
    end,
  );
  expect(tail.length).toBeGreaterThan(5);
  expect(tail.every((frame: { max: number }) => frame.max === 0)).toBe(true);
  await page.getByText('语音唤醒', { exact: true }).click();
  await page.getByText('音频来源与回声', { exact: true }).click();
  await expect(page.getByText(/浏览器报告：回声消除/)).toBeVisible();
  await page.getByRole('button', { name: '关闭语音', exact: true }).click();
});

test('service reconnect status is separate from local wake and explicit disconnect does not trigger an automatic reconnect', async ({
  page,
}) => {
  await syntheticMicrophone(page);
  const f = await open(page, runtime());
  f.publishVoice({
    configured: true,
    status: 'ready',
    wakePreference: defaultWake,
    connectionPreference: defaultWake,
    wake: installedWake,
  });
  await expect(page.getByRole('status', { name: '语音服务连接状态', exact: true })).toHaveText(
    '服务已连接',
  );
  await expect(page.getByRole('status').filter({ hasText: '本地待唤醒' })).toBeVisible();
  f.publishVoice({
    status: 'failed',
    connection: {
      attempt: 3,
      nextRetryAt: new Date(Date.now() + 4000).toISOString(),
      exhausted: false,
    },
  });
  await expect(page.getByRole('status', { name: '语音服务连接状态', exact: true })).toHaveText(
    '服务重连 3/6',
  );
  expect(
    await page.evaluate(() =>
      (Reflect.get(window, 'syntheticTracks') as MediaStreamTrack[]).every(
        (t) => t.readyState === 'live',
      ),
    ),
  ).toBe(true);
  f.publishVoice({
    status: 'ready',
    connection: { attempt: 3, nextRetryAt: null, exhausted: false },
  });
  await page.locator('summary[aria-label="更多语音操作"]').click();
  await page.getByRole('button', { name: '断开语音服务', exact: true }).click();
  await expect(page.getByRole('status', { name: '语音服务连接状态', exact: true })).toHaveText(
    '服务已手动断开',
  );
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect(f.voiceCommands.some((c) => c.action === 'retry-connection')).toBe(false);
  await page.getByText('语音唤醒', { exact: true }).click();
  await page.getByRole('button', { name: '关闭语音唤醒', exact: true }).click();
});
