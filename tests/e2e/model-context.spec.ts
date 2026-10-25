import { randomUUID } from 'node:crypto';
import {
  type ThreadRuntime,
  taskSchema,
  type VoiceDebugState,
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
          snapshot: async () => Reflect.get(window, 'testPreviewSnapshot') ?? null,
          inspect: async (input: unknown) => Reflect.get(window, 'testPreviewInspect')(input),
          scrollPreview: async (input: unknown) => {
            Reflect.set(window, 'previewScroll', input);
          },
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
            if (Reflect.get(window, 'failCopy')) throw new Error('clipboard_failed');
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
    wakePreference: { version: 1, enabled: false, source: 'user' },
    connectionPreference: { version: 1, enabled: false, source: 'user' },
  });
  await page.route('**/api/voice', (route) => route.fulfill({ json: voice }));
  await page.route('**/api/voice/inspect', (route) => route.fulfill({ json: voice }));
  await page.route('**/api/voice/debug', (route) =>
    route.fulfill({
      json: {
        build: { version: 'fixture', commit: null, dirty: false, builtAt: null },
        enabled: true,
        capacity: 256,
        retentionMinutes: 30,
        maxPayloadCharacters: 8192,
        importantCapacity: 96,
        droppedImportant: 0,
        truncated: 0,
        dropped: 0,
        events: [],
      },
    }),
  );
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
async function openVoiceMenu(page: Page) {
  const menu = page.locator('.voice-more');
  if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open)))
    await page.getByLabel('更多语音操作', { exact: true }).click();
}

test('composer loads models automatically, limits effort choices and resets incompatible effort', async ({
  page,
}) => {
  const fixture = await open(page, runtime(), true);
  await page.getByRole('button', { name: '文字输入', exact: true }).click();
  await page.locator('.composer-options > summary').click();
  await expect(page.getByText('模型列表读取失败，已保存的选择仍保留。')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toHaveText(
    '已保存：test-model',
  );
  await expect(page.getByRole('combobox', { name: 'Reasoning Effort', exact: true })).toHaveText(
    '已保存：high',
  );
  fixture.allowModels();
  await page.getByRole('button', { name: '刷新模型列表' }).click();
  await page.getByRole('combobox', { name: '模型', exact: true }).click();
  await expect(page.getByRole('option')).toHaveText([
    '沿用线程（test-model）',
    'Test Model',
    'Fast Model',
  ]);
  await page.getByRole('option', { name: 'Fast Model', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Reasoning Effort', exact: true })).toHaveText(
    'low（模型默认）',
  );
  await page.getByRole('combobox', { name: 'Reasoning Effort', exact: true }).click();
  await expect(page.getByRole('option')).toHaveText(['沿用 Codex 设置', 'low（模型默认）']);
  await expect(page.getByRole('option', { name: /^high/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
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
  // Settle the scroll before selecting text in the resized conversation column.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
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
  await page.getByRole('button', { name: '文字输入', exact: true }).click();
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
  await page.getByRole('button', { name: '文字输入', exact: true }).click();
  await page.getByLabel('给 Codex 的本轮指令').fill('主对话未发送的草稿');
  await selectExcerpt(page, source.id, '请讨论这个按钮。');
  await page.getByRole('button', { name: '选段 Sidechat', exact: true }).click();
  await page.locator('.composer-options > summary').click();
  await expect(page.getByRole('combobox', { name: '权限', exact: true })).toHaveText(
    'Sidechat · 只读',
  );
  await expect(page.getByRole('combobox', { name: '权限', exact: true })).toBeDisabled();
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
  await page.getByRole('button', { name: '文字输入', exact: true }).click();
  await selectExcerpt(page, answer.id, '讨论结论：保留这个按钮。');
  await page.getByRole('button', { name: '引用到原对话' }).click();
  await expect(page.getByLabel('给 Codex 的本轮指令')).toHaveValue('主对话未发送的草稿');
  await expect(page.locator('.context-attachments')).toContainText('讨论结论：保留这个按钮。');
  await page.locator('.workbench-menu > summary').click();
  await page.locator('.workspace-conversations > summary').click();
  await page.getByRole('combobox', { name: '切换对话' }).click();
  await page.getByRole('option', { name: 'Sidechat · 选段讨论', exact: true }).click();
  await expect.poll(() => fixture.state().selectedThreadId).toBe(sideId);
  await page.locator('.workbench-menu > summary').click();
  await page.getByRole('button', { name: '文字输入', exact: true }).click();
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
  await page.getByRole('button', { name: '文字输入', exact: true }).click();
  await page.locator('.composer-options > summary').click();
  await page.getByRole('combobox', { name: '工作模式', exact: true }).click();
  await expect(page.getByRole('option')).toHaveText(['执行模式', '计划模式']);
  await expect(page.getByRole('option', { name: '计划模式', exact: true })).toBeEnabled();
  await page.getByRole('option', { name: '计划模式', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '工作模式', exact: true })).toHaveText(
    '计划模式',
  );
  expect(fixture.state().settings.plan).toBe(true);
  await page.getByRole('combobox', { name: '权限', exact: true }).click();
  await expect(page.getByRole('option')).toHaveText([
    'Manual · 手动审批',
    'Approve for me · 自动审查',
    'Full Access · 完整访问',
  ]);
  await page.getByRole('option', { name: 'Full Access · 完整访问', exact: true }).click();
  await expect(page.getByRole('region', { name: '执行设置' })).toContainText(
    '可访问沙箱外文件和网络',
  );
  expect(fixture.state().permission).toBe('full-access');
  await page.getByRole('combobox', { name: '权限', exact: true }).click();
  await page.getByRole('option', { name: 'Approve for me · 自动审查', exact: true }).click();
  await expect(page.getByRole('region', { name: '执行设置' })).toContainText(
    '越界请求由 Codex 自动审查',
  );
  await page.getByRole('combobox', { name: '工作模式', exact: true }).click();
  await page.getByRole('option', { name: '执行模式', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '工作模式', exact: true })).toHaveText(
    '执行模式',
  );
  await page.getByText('模式说明与兼容验证', { exact: true }).click();
  await page.getByRole('button', { name: '验证执行设置', exact: true }).click();
  await expect(
    page.getByText('已由 Codex 确认：计划模式、执行模式、Manual · 手动审批'),
  ).toBeVisible();
  await expect(page.getByText('先给计划并请求确认', { exact: true })).toHaveCount(0);
});

test('selection controls cannot open or send changes while saving or verifying settings', async ({
  page,
}) => {
  const f = await open(page, runtime());
  let releaseSave = () => {};
  let releaseVerification = () => {};
  const saving = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const verifying = new Promise<void>((resolve) => {
    releaseVerification = resolve;
  });
  let workspaceRequests = 0;
  let verificationRequests = 0;
  await page.route('**/api/workbench/workspace', async (route) => {
    workspaceRequests++;
    await saving;
    return route.fallback();
  });
  await page.route('**/api/workbench/verify-execution', async (route) => {
    verificationRequests++;
    await verifying;
    return route.fallback();
  });
  try {
    await page.getByRole('button', { name: '文字输入', exact: true }).click();
    await page.locator('.composer-options > summary').click();
    await page.getByRole('combobox', { name: '模型', exact: true }).click();
    await page.getByRole('option', { name: 'Fast Model', exact: true }).click();
    await expect.poll(() => workspaceRequests).toBe(1);
    for (const name of ['模型', 'Reasoning Effort', '工作模式', '权限']) {
      const control = page.getByRole('combobox', { name, exact: true });
      await expect(control).toBeDisabled();
      await expect(control).toHaveAttribute('disabled', '');
      await control.click({ force: true });
      await expect(page.getByRole('option')).toHaveCount(0);
    }
    expect(workspaceRequests).toBe(1);
    expect(f.commands).toHaveLength(0);
    releaseSave();
    await expect(page.getByRole('combobox', { name: '模型', exact: true })).toHaveText(
      'Fast Model',
    );
    await expect(
      page.getByRole('combobox', { name: 'Reasoning Effort', exact: true }),
    ).toBeEnabled();
    expect(f.state().settings).toMatchObject({ model: 'fast-model', effort: 'low' });

    await page.getByText('模式说明与兼容验证', { exact: true }).click();
    await page.getByRole('button', { name: '验证执行设置', exact: true }).click();
    await expect.poll(() => verificationRequests).toBe(1);
    for (const name of ['工作模式', '权限']) {
      const control = page.getByRole('combobox', { name, exact: true });
      await expect(control).toBeDisabled();
      await expect(control).toHaveAttribute('disabled', '');
      await control.click({ force: true });
      await expect(page.getByRole('option')).toHaveCount(0);
    }
    expect(workspaceRequests).toBe(1);
    expect(verificationRequests).toBe(1);
    expect(f.commands).toHaveLength(1);
    releaseVerification();
    await expect(
      page.getByText('已由 Codex 确认：计划模式、执行模式、Manual · 手动审批'),
    ).toBeVisible();
    await expect(page.getByRole('combobox', { name: '工作模式', exact: true })).toBeEnabled();
    await expect(page.getByRole('combobox', { name: '权限', exact: true })).toBeEnabled();
  } finally {
    releaseSave();
    releaseVerification();
  }
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
  await page.getByRole('button', { name: '文字输入', exact: true }).click();
  await page.getByLabel('给 Codex 的本轮指令').fill('本轮待发送草稿');
  await openVoiceMenu(page);
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
  await page.getByRole('button', { name: '文字输入', exact: true }).click();
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
  await page.getByRole('button', { name: '文字输入', exact: true }).click();
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
  await page.getByRole('button', { name: '文字输入', exact: true }).click();
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
  await openVoiceMenu(page);
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
  await openVoiceMenu(page);
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
  await openVoiceMenu(page);
  await page.getByRole('button', { name: '关闭语音唤醒', exact: true }).click();
});

async function previewFixture(page: Page) {
  const binding = {
    id: randomUUID(),
    projectId,
    revision: 1,
    epoch: 1,
    url: 'http://127.0.0.1:5174/',
    title: 'Test preview',
  };
  await page.addInitScript(
    ({ binding }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 600;
      const context = canvas.getContext('2d');
      context?.fillRect(0, 0, 800, 600);
      Reflect.set(window, 'testPreviewSnapshot', {
        binding,
        text: 'Preview',
        image: canvas.toDataURL('image/png').split(',')[1],
        width: 800,
        height: 600,
      });
      Reflect.set(
        window,
        'testPreviewInspect',
        async (input: { target: string; x?: number; ref?: string }) => {
          const right = input.ref === 'r2' || (input.x ?? 0) > 0.5;
          const value = {
            binding,
            ref: right ? 'r2' : 'r1',
            description: right ? 'Right button' : 'Left button',
            label: right ? 'button#right' : 'button#left',
            bounds: { x: right ? 0.55 : 0.15, y: 0.3, width: 0.25, height: 0.15 },
          };
          if (Reflect.get(window, 'holdPreview'))
            return new Promise((resolve) => {
              const pending = Reflect.get(window, 'pendingPreview') ?? [];
              pending.push(() => resolve(value));
              Reflect.set(window, 'pendingPreview', pending);
            });
          return value;
        },
      );
    },
    { binding },
  );
  return open(page, runtime(), false, { preview: binding });
}
test('annotation hover switches targets, locks into the draft, scrolls only while picking and clears on cancel', async ({
  page,
}) => {
  await previewFixture(page);
  await page.getByRole('button', { name: '批注修改', exact: true }).click();
  const image = await page.locator('.preview-pick img').boundingBox();
  if (!image) throw new Error('missing preview');
  const center = { x: image.x + image.width / 2, y: image.y + image.height / 2 };
  await page.mouse.move(center.x - 30, center.y);
  await expect(page.locator('.preview-element-label')).toHaveText('button#left');
  await page.mouse.move(center.x + 30, center.y);
  await expect(page.locator('.preview-element-label')).toHaveText('button#right');
  await page.mouse.wheel(0, 120);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'previewScroll')?.deltaY))
    .toBe(120);
  await page.mouse.click(center.x + 30, center.y);
  await expect(page.getByLabel('给选中元素的批注', { exact: true })).toBeVisible();
  await expect(page.locator('.preview-element-outline.locked')).toBeVisible();
  await page.getByRole('button', { name: '清除选择', exact: true }).click();
  await expect(page.locator('.preview-element-outline')).toHaveCount(0);
  await page.getByRole('button', { name: '批注修改', exact: true }).click();
  await page.mouse.move(center.x, center.y);
  await page.keyboard.press('Escape');
  await expect(page.locator('.preview-element-outline')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '批注修改', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
test('Esc discards late hover and click replies without selecting or submitting an element', async ({
  page,
}) => {
  const f = await previewFixture(page);
  await page.evaluate(() => Reflect.set(window, 'holdPreview', true));
  await page.getByRole('button', { name: '批注修改', exact: true }).click();
  const image = await page.locator('.preview-pick img').boundingBox();
  if (!image) throw new Error('missing preview');
  await page.mouse.move(image.x + image.width / 2, image.y + image.height / 2);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'pendingPreview')?.length ?? 0))
    .toBeGreaterThan(0);
  await page.mouse.click(image.x + image.width / 2, image.y + image.height / 2);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    Reflect.set(window, 'holdPreview', false);
    for (const resolve of Reflect.get(window, 'pendingPreview') ?? []) resolve();
  });
  await expect(page.locator('.preview-element-outline')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '清除选择', exact: true })).toHaveCount(0);
  expect(f.commands).toHaveLength(0);
});

test('header project controls reuse existing actions and respect project and task availability', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 940 });
  const fixture = await open(page, null, false, { project: null });
  const actions: string[] = [];
  await page.route('**/api/workbench/action', (route) => {
    actions.push(route.request().postDataJSON().action);
    return route.fulfill({ json: fixture.state() });
  });
  await expect(
    page.getByText('点击右上角新建项目或者打开项目，开始和我聊聊你的想法吧', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await expect.poll(() => actions).toEqual(['new-project']);
  const menu = page.getByLabel('更多项目操作');
  await menu.click();
  await expect(page.getByRole('button', { name: '刷新作品', exact: true })).toBeDisabled();
  fixture.publishVoice({ configured: true, status: 'ready' });
  await expect(page.getByRole('status', { name: '语音服务连接状态', exact: true })).toHaveCSS(
    'color',
    'rgb(35, 115, 74)',
  );
  await expect(page.locator('.voice-status > svg > path').first()).toHaveAttribute('d', /^m2 2/);
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('project-header-connected.png') });
  await page.getByRole('button', { name: '打开项目', exact: true }).click();
  await expect.poll(() => actions).toEqual(['new-project', 'select-project']);
  await expect(page.locator('.project-menu')).not.toHaveAttribute('open');
  await fixture.publish({ project: { id: projectId, name: 'Test', path: '/fixture' } });
  await menu.focus();
  await menu.press('Enter');
  await page.getByRole('button', { name: '刷新作品', exact: true }).click();
  await expect.poll(() => actions).toEqual(['new-project', 'select-project', 'publish-preview']);
  await fixture.publish({ task: turn('正在执行', 'running') });
  await expect(page.getByRole('button', { name: '新建项目', exact: true })).toBeDisabled();
  await menu.click();
  await expect(page.getByRole('button', { name: '打开项目', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '刷新作品', exact: true })).toBeDisabled();
});

test('operator and display distinguish service connection, local wake and actual microphone state', async ({
  page,
}) => {
  const f = await open(page, runtime());
  const cases = [
    { status: 'ready', active: false, wake: 'off', muted: true, label: '服务已连接' },
    { status: 'ready', active: false, wake: 'armed', muted: false, label: '服务已连接' },
    { status: 'listening', active: true, wake: 'off', muted: false, label: '服务已连接' },
    { status: 'speaking', active: true, wake: 'off', muted: false, label: '服务已连接' },
    { status: 'disconnected', active: false, wake: 'armed', muted: false, label: '服务已手动断开' },
    { status: 'failed', active: false, wake: 'off', muted: true, label: '服务重连 2/6' },
  ] as const;
  for (const path of ['/', '/display']) {
    await page.goto(path);
    const icon = page
      .locator(path === '/' ? '.voice-status > svg > path' : '.live-mic-state > svg > path')
      .first();
    const service = page.getByRole('status', { name: '语音服务连接状态', exact: true });
    for (const row of cases) {
      f.publishVoice({
        configured: true,
        status: row.status,
        conversationActive: row.active,
        connectionPreference: {
          version: 1,
          enabled: row.status !== 'disconnected',
          source: 'user',
        },
        connection: {
          attempt: row.status === 'failed' ? 2 : 0,
          nextRetryAt: row.status === 'failed' ? new Date(Date.now() + 4000).toISOString() : null,
          exhausted: false,
        },
        wake: {
          status: row.wake,
          keyword: '丽塔同学',
          installed: true,
          detectionId: null,
          error: null,
        },
      });
      await expect(service).toHaveText(row.label);
      await expect(icon).toBeVisible();
      if (row.muted) await expect(icon).toHaveAttribute('d', /^m2 2/);
      else await expect(icon).not.toHaveAttribute('d', /^m2 2/);
      if (row.label === '服务已连接') await expect(service).toHaveCSS('color', 'rgb(35, 115, 74)');
    }
    if (path === '/display') {
      await expect(page.getByRole('button', { name: '设置', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '新建项目', exact: true })).toHaveCount(0);
    }
  }
  expect(f.commands).toHaveLength(0);
});

test('voice diagnostics show actual status calls and copy only bounded metadata', async ({
  page,
}) => {
  const f = await open(page, runtime());
  const capture = randomUUID(),
    session = randomUUID();
  let diagnostics = {
    enabled: true,
    capacity: 128,
    retentionMinutes: 30,
    dropped: 7,
    snapshot: {
      connection: 'ready',
      projectSelected: true,
      conversationSelected: false,
      voiceSubmitEnabled: true,
      toolsListed: true,
      captureActive: true,
    },
    events: [
      {
        sequence: 8,
        at: new Date().toISOString(),
        kind: 'tools-discovered',
        sessionId: session,
        captureId: null,
        projectId,
        conversationId: null,
        taskId: null,
      },
      {
        sequence: 9,
        at: new Date().toISOString(),
        kind: 'tool-called',
        sessionId: session,
        captureId: capture,
        projectId,
        conversationId: null,
        taskId: null,
        tool: 'workbench_status',
      },
      {
        sequence: 10,
        at: new Date().toISOString(),
        kind: 'tool-returned',
        sessionId: session,
        captureId: capture,
        projectId,
        conversationId: null,
        taskId: null,
        tool: 'workbench_status',
      },
    ],
  };
  await page.route('**/api/voice/diagnostics', (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ action: 'clear' });
      diagnostics = {
        ...diagnostics,
        events: [],
        dropped: 0,
      };
    }
    return route.fulfill({ json: diagnostics });
  });
  f.publishVoice({ configured: true, status: 'ready', draft: 'PRIVATE_TRANSCRIPT' });
  await page.locator('.voice-handoff-menu > summary').click();
  await page.getByRole('button', { name: '语音诊断', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '语音交接诊断' });
  await expect(dialog).toContainText('收到工具调用');
  await expect(dialog).toContainText('工具已返回结果');
  await expect(dialog.getByText('workbench_status', { exact: false })).toHaveCount(2);
  await page.getByRole('button', { name: '复制诊断日志', exact: true }).click();
  const copied = await page.evaluate(() => Reflect.get(window, 'copiedReply'));
  expect(copied).toContain('workbench_status');
  expect(copied).toContain(capture);
  expect(copied).not.toContain('PRIVATE_TRANSCRIPT');
  expect(copied).toContain('应用版本:');
  expect(copied).toContain('UTC');
  expect(copied).toContain('128 条 / 30 分钟');
  expect(copied).toContain('dropped: 7');
  await expect(dialog).toContainText('旧记录已轮转或过期 7 条');
  await expect(dialog.getByRole('status')).toHaveText('已复制诊断日志，不包含语音正文。');
  await page.evaluate(() => Reflect.set(window, 'failCopy', true));
  await page.getByRole('button', { name: '复制诊断日志', exact: true }).click();
  await expect(dialog.getByLabel('诊断日志文本（可手动复制）')).toHaveValue(/workbench_status/);
  await expect(dialog.getByRole('status')).toHaveCount(0);
  await expect(dialog).toContainText('无法自动复制');

  await page.getByRole('button', { name: '清空诊断', exact: true }).click();
  await expect(dialog).toContainText('尚无阶段记录');
  await page.getByRole('button', { name: '复制诊断日志', exact: true }).click();
  await expect(dialog.getByLabel('诊断日志文本（可手动复制）')).toHaveValue(
    /Enabled: true; dropped: 0; events: 0/,
  );
  await expect(page.getByRole('checkbox', { name: '记录脱敏诊断' })).toHaveCount(0);

  await page.getByRole('button', { name: '关闭诊断', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.commands).toHaveLength(0);
});

test('detailed voice logs always record, copy separately with a warning, and continue after clear', async ({
  page,
}) => {
  const f = await open(page, runtime());
  const entry = {
    sequence: 1,
    at: new Date().toISOString(),
    direction: 'inbound' as const,
    event: 'message' as const,
    sessionId: randomUUID(),
    captureId: randomUUID(),
    projectId,
    conversationId,
    taskId: null,
    payload: JSON.stringify({
      type: 'mcp',
      params: {
        name: 'workbench_submit',
        arguments: { text: 'PRIVATE_DIALOG_CONTENT', token: '[REDACTED]' },
      },
      result: { status: 'accepted' },
    }),
    truncated: true,
    priority: 'important' as const,
  };
  let debug: VoiceDebugState = {
    build: { version: 'fixture', commit: null, dirty: false, builtAt: null },
    enabled: true,
    capacity: 256,
    retentionMinutes: 30,
    maxPayloadCharacters: 8192,
    importantCapacity: 96,
    droppedImportant: 0,
    truncated: 1,
    dropped: 0,
    events: [entry],
  };
  const actions: unknown[] = [];
  await page.route('**/api/voice/debug', (route) => {
    if (route.request().method() === 'POST') {
      const action = route.request().postDataJSON();
      actions.push(action);
      debug = { ...debug, events: [], dropped: 0, droppedImportant: 0, truncated: 0 };
    }
    return route.fulfill({ json: debug });
  });
  f.publishVoice({ configured: true, status: 'ready' });
  await page.locator('.voice-handoff-menu > summary').click();
  await page.getByRole('button', { name: '语音诊断', exact: true }).click();
  const panel = page.getByRole('region', { name: '详细语音调试' });
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await expect(panel).toContainText('应用运行时自动记录');
  await expect(panel).toContainText('部分 payload 已截断');
  await expect(panel).toContainText('本次累计截断 1 条');
  await expect(panel).toContainText('重要事件保留 96 条');
  expect(actions).toHaveLength(0);
  await panel.getByText('预览详细日志（含对话内容）', { exact: true }).click();
  await expect(panel.getByLabel('详细调试日志预览（含对话内容）')).toHaveValue(
    /PRIVATE_DIALOG_CONTENT/,
  );
  await panel.getByRole('button', { name: '复制详细日志（含对话内容）' }).click();
  await expect(panel.getByRole('status')).toContainText('已复制详细日志，包含对话内容');
  let copied = await page.evaluate(() => Reflect.get(window, 'copiedReply'));
  expect(copied).toContain('PRIVATE_DIALOG_CONTENT');
  expect(copied).toContain('[REDACTED]');
  expect(copied).toContain('不是未经修改的原始网络包');
  expect(copied).toContain('truncated=true');
  await page.getByRole('button', { name: '复制诊断日志', exact: true }).click();
  copied = await page.evaluate(() => Reflect.get(window, 'copiedReply'));
  expect(copied).not.toContain('PRIVATE_DIALOG_CONTENT');
  await page.evaluate(() => Reflect.set(window, 'failCopy', true));
  await panel.getByRole('button', { name: '复制详细日志（含对话内容）' }).click();
  await expect(panel.getByLabel('详细日志文本（可手动复制）')).toHaveValue(
    /PRIVATE_DIALOG_CONTENT/,
  );
  await expect(panel.getByRole('status')).toHaveCount(0);
  await expect(panel).toContainText('无法自动复制详细日志');
  await panel.getByRole('button', { name: '清空详细调试' }).click();
  await expect(panel).toContainText('本次累计截断 0 条');
  await expect(panel.getByLabel('详细调试日志预览（含对话内容）')).not.toHaveValue(
    /PRIVATE_DIALOG_CONTENT/,
  );
  await expect(panel.getByLabel('详细日志文本（可手动复制）')).toHaveCount(0);
  debug = {
    ...debug,
    events: [{ ...entry, sequence: 2, payload: 'AFTER_CLEAR_CONTENT', truncated: false }],
  };
  await expect(panel.getByLabel('详细调试日志预览（含对话内容）')).toHaveValue(
    /AFTER_CLEAR_CONTENT/,
  );
  expect(actions).toEqual([{ action: 'clear' }]);
  expect(f.commands).toHaveLength(0);
  expect(await page.evaluate(() => Reflect.get(window, 'permissionRequests') ?? 0)).toBe(0);
});

test('settings show all three defaults on while preserving saved off choices without requesting audio', async ({
  page,
}) => {
  const f = await open(page, runtime());
  const defaults = voiceStateSchema.parse({
    configured: true,
    status: 'ready',
    draft: '',
    captureId: null,
    subtitle: '',
    error: null,
  });
  f.publishVoice(defaults);
  await page.goto('/settings#lingxi');
  const connection = page.getByRole('checkbox', { name: '应用启动后自动连接并保持语音服务' });
  const execution = page.getByRole('checkbox', {
    name: '允许主动收音后用语音提交/停止任务、切换计划模式（保存后需重新连接）',
  });
  await expect(connection).toBeChecked();
  await expect(execution).toBeChecked();
  await execution.click();
  await expect(execution).not.toBeChecked();
  await page.reload();
  await expect(execution).not.toBeChecked();
  await page.getByText('高级：手动配置已绑定设备', { exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: '允许主动收音后，通过丽塔同学 MCP 提交或停止 Codex 任务' }),
  ).not.toBeChecked();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: /语音唤醒与麦克风/ })
    .click();
  await expect(page.getByRole('checkbox', { name: '自动开启本地语音唤醒' })).toBeChecked();
  const off = { version: 1 as const, enabled: false, source: 'user' as const };
  f.publishVoice({ wakePreference: off, connectionPreference: off });
  await expect(page.getByRole('checkbox', { name: '自动开启本地语音唤醒' })).not.toBeChecked();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: /丽塔同学与语音执行/ })
    .click();
  await expect(connection).not.toBeChecked();
  await expect(execution).not.toBeChecked();
  expect(await page.evaluate(() => Reflect.get(window, 'permissionRequests') ?? 0)).toBe(0);
  expect(f.commands).toHaveLength(0);
});

test('goodbye is shown as a remote session ending before reconnect, without opening another capture', async ({
  page,
}) => {
  const f = await open(page, runtime());
  f.publishVoice({ configured: true, status: 'ready', remoteSessionEnding: true });
  await expect(page.getByRole('status', { name: '语音服务连接状态' })).toHaveText(
    '远端语音会话正在结束',
  );
  await expect(page.getByRole('button', { name: '开始收音', exact: true })).toBeDisabled();
  await page.goto('/display');
  await expect(page.getByRole('status', { name: '语音服务连接状态' })).toHaveText(
    '远端语音会话正在结束',
  );
  await expect(page.locator('.live-mic-state strong')).toHaveText(
    '远端会话正在结束 · 等待服务重连',
  );
  f.publishVoice({
    configured: true,
    status: 'ready',
    remoteSessionEnding: false,
    captureId: null,
    conversationActive: false,
  });
  await expect(page.getByRole('status', { name: '语音服务连接状态' })).toHaveText('服务已连接');
  expect(f.commands).toHaveLength(0);
  expect(await page.evaluate(() => Reflect.get(window, 'permissionRequests') ?? 0)).toBe(0);
});

test('projectless voice messages stream, settle once and survive a page refresh without becoming tasks', async ({
  page,
}) => {
  const f = await open(page, runtime(), false, { project: null });
  const turnId = randomUUID(),
    capture = randomUUID(),
    messageId = randomUUID(),
    assistantId = randomUUID();
  let chat = {
    revision: 1,
    turns: [
      {
        id: turnId,
        sessionId: randomUUID(),
        captureId: capture,
        projectId: null,
        conversationId: null,
        at: new Date().toISOString(),
        handoff: {
          captureId: capture,
          status: 'awaiting-tool',
          taskId: null,
          message: '等待工具调用',
        },
        taskStatus: null,
        messages: [
          {
            id: messageId,
            role: 'user',
            text: '请检查',
            state: 'streaming',
            at: new Date().toISOString(),
          },
        ],
      },
    ],
  };
  await page.route('**/api/voice/conversation', (route) => {
    if (route.request().method() === 'POST') chat = { revision: chat.revision + 1, turns: [] };
    return route.fulfill({ json: chat });
  });
  await expect(page.locator('[data-voice-message]')).toHaveText('请检查');
  await expect(page.getByText('发言人 · 语音 · 接收中', { exact: true })).toBeVisible();
  chat = {
    ...chat,
    revision: 2,
    turns: [
      {
        ...chat.turns[0]!,
        messages: [
          { ...chat.turns[0]!.messages[0]!, text: '请检查页面', state: 'final' },
          {
            id: assistantId,
            role: 'assistant',
            text: '我先看看',
            state: 'streaming',
            at: new Date().toISOString(),
          },
        ],
      },
    ],
  };
  await expect(page.locator('[data-voice-message]')).toHaveCount(2);
  await expect(page.getByText('丽塔同学 · 语音回复 · 接收中', { exact: true })).toBeVisible();
  chat = {
    ...chat,
    revision: 3,
    turns: [
      {
        ...chat.turns[0]!,
        handoff: { captureId: capture, status: 'unhandled', taskId: null, message: '没有调用工具' },
        messages: chat.turns[0]!.messages.map((message) => ({ ...message, state: 'final' })),
      },
    ],
  };
  await expect(page.getByText('本轮未提交 Codex', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-voice-message]')).toHaveCount(2);
  await f.publish({ project: { id: projectId, name: 'Test', path: '/fixture' } });
  await page.getByText('项目外语音 · 未用于当前项目', { exact: true }).click();
  await expect(page.getByText('请检查页面', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除本次语音记录', exact: true }).click();
  await expect(page.locator('[data-voice-message]')).toHaveCount(0);
  expect(f.commands).toHaveLength(0);
});

test('accepted voice links the actual task and never treats spoken completion as runner success', async ({
  page,
}) => {
  const task = turn('只读检查');
  const f = await open(page, runtime(), false, {
    task,
    history: [task],
    threads: [historyThread()],
    selectedThreadId: conversationId,
  });
  let chat = {
    revision: 1,
    turns: [
      {
        id: randomUUID(),
        sessionId: randomUUID(),
        captureId: task.id,
        projectId,
        conversationId,
        at: new Date().toISOString(),
        handoff: { captureId: task.id, status: 'submitted', taskId: task.id, message: '已提交' },
        taskStatus: 'running',
        messages: [
          {
            id: randomUUID(),
            role: 'user',
            text: task.prompt,
            state: 'final',
            at: new Date().toISOString(),
          },
          {
            id: randomUUID(),
            role: 'assistant',
            text: '我已经完成了',
            state: 'final',
            at: new Date().toISOString(),
          },
        ],
      },
    ],
  };
  await page.route('**/api/voice/conversation', (route) => route.fulfill({ json: chat }));
  await expect(page.getByText('我已经完成了', { exact: true })).toBeVisible();
  await expect(page.getByText('Codex 执行中', { exact: false })).toBeVisible();
  await expect(page.locator(`[data-voice-turn] a[href="#codex-turn-${task.id}"]`)).toBeVisible();
  await expect(page.getByText(task.prompt, { exact: true })).toHaveCount(1);
  chat = {
    ...chat,
    revision: 2,
    turns: chat.turns.map((turn) => ({ ...turn, taskStatus: 'failed' })),
  };
  await expect(page.getByText('Codex 执行失败', { exact: false })).toBeVisible();
  expect(f.commands).toHaveLength(0);
});

test('auxiliary forms stay within their column, close predictably and preserve drafts', async ({
  page,
}) => {
  await open(page, runtime());
  for (const width of [1440, 998, 759]) {
    await page.setViewportSize({ width, height: 767 });
    await page.getByRole('button', { name: '文字输入', exact: true }).click();
    await page.getByLabel('给 Codex 的本轮指令').fill('保留这份草稿');
    const composer = page.getByRole('form', { name: '文字指令' });
    const form = await composer.boundingBox();
    const conversation = await page.locator('.live-discussion').boundingBox();
    if (!form || !conversation) throw new Error('Composer is missing');
    expect(form.x).toBeGreaterThanOrEqual(conversation.x);
    expect(form.x + form.width).toBeLessThanOrEqual(conversation.x + conversation.width);
    if (
      !(await page
        .locator('.composer-options')
        .evaluate((element) => (element as HTMLDetailsElement).open))
    )
      await page.locator('.composer-options > summary').click();
    await page.getByRole('combobox', { name: '模型', exact: true }).click();
    await page.getByRole('option', { name: 'Fast Model', exact: true }).click();
    await expect(composer).toBeVisible();
    const workspaceTrigger = page.locator('.workbench-menu > summary');
    const triggerBefore = await workspaceTrigger.boundingBox();
    await workspaceTrigger.click();
    expect(await workspaceTrigger.boundingBox()).toEqual(triggerBefore);
    await expect(workspaceTrigger.locator('svg')).toHaveCSS(
      'transform',
      'matrix(-1, 0, 0, -1, 0, 0)',
    );
    await expect(composer).not.toBeVisible();
    const panel = await page.locator('.workbench-menu-content').boundingBox();
    if (!panel) throw new Error('Workspace panel is missing');
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    await expect(page.locator('.workbench-menu')).not.toHaveAttribute('open', '');
    await page.getByRole('button', { name: '文字输入', exact: true }).click();
    await expect(page.getByLabel('给 Codex 的本轮指令')).toHaveValue('保留这份草稿');
    await openVoiceMenu(page);
    await expect(composer).not.toBeVisible();
    const wake = await page.locator('.voice-menu-content').boundingBox();
    if (!wake) throw new Error('Wake panel is missing');
    expect(wake.x).toBeGreaterThanOrEqual(0);
    expect(wake.x + wake.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test('footer groups actions beside text input and keeps healthy diagnostics compact', async ({
  page,
}) => {
  const f = await open(page, runtime());
  f.publishVoice({ configured: true, status: 'ready', subtitle: '上一轮已经结束的字幕' });
  const footer = page.locator('.live-footer');
  await expect(footer).not.toContainText('上一轮已经结束的字幕');
  await expect(page.locator('.voice-handoff-details')).not.toBeVisible();
  for (const width of [1440, 998, 759]) {
    await page.setViewportSize({ width, height: 767 });
    const status = await footer.locator('.voice-status').boundingBox();
    const listen = await page.getByRole('button', { name: '开始收音', exact: true }).boundingBox();
    const more = await page.getByLabel('更多语音操作', { exact: true }).boundingBox();
    const text = await page.getByRole('button', { name: '文字输入', exact: true }).boundingBox();
    if (!status || !listen || !more || !text) throw new Error('Voice action is missing');
    expect(status.x).toBeLessThan(listen.x);
    expect(listen.x + listen.width).toBeLessThanOrEqual(more.x);
    expect(more.x + more.width).toBeLessThanOrEqual(text.x);
    expect(Math.abs(listen.y - text.y)).toBeLessThanOrEqual(2);
    await expect(footer.getByRole('heading', { name: '语音唤醒', exact: true })).not.toBeVisible();
    const meter = await page.getByRole('meter', { name: '当前上下文占用' }).boundingBox();
    if (!meter) throw new Error('Context meter is missing');
    expect(meter.width).toBeLessThanOrEqual(48);
    const context = await page.locator('.context-toggle-compact').boundingBox();
    if (!context) throw new Error('Compact context control is missing');
    expect(context.height).toBeLessThanOrEqual(28);
    const panelBefore = await page.locator('.live-grid').boundingBox();
    const footerBefore = await footer.boundingBox();
    await openVoiceMenu(page);
    await expect(footer.getByRole('heading', { name: '语音唤醒', exact: true })).toBeVisible();
    expect(await page.locator('.live-grid').boundingBox()).toEqual(panelBefore);
    expect(await footer.boundingBox()).toEqual(footerBefore);
    await page.getByText('音频来源与回声', { exact: true }).click();
    expect(await page.locator('.live-grid').boundingBox()).toEqual(panelBefore);
    expect(await footer.boundingBox()).toEqual(footerBefore);
    await expect(page.getByRole('button', { name: '语音设置', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
  }
  f.publishVoice({
    status: 'speaking',
    conversationActive: true,
    captureId: randomUUID(),
    subtitle: '正在播报的回复\n第二行语音字幕',
  });
  await expect(footer).toContainText('第二行语音字幕');
  const keyboard = await page.getByRole('button', { name: '文字输入', exact: true }).boundingBox();
  const close = await page.getByRole('button', { name: '关闭语音', exact: true }).boundingBox();
  const stop = await page.getByRole('button', { name: '停止播报', exact: true }).boundingBox();
  if (!keyboard || !close || !stop) throw new Error('Voice action is missing during playback');
  expect(Math.abs(keyboard.y - close.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(keyboard.y - stop.y)).toBeLessThanOrEqual(2);
  f.publishVoice({ status: 'ready', conversationActive: false });
  await expect(footer).not.toContainText('正在播报的回复');
});

test('context and voice details stay exclusive and dismissible for clicks, failures and server updates', async ({
  page,
}) => {
  const f = await open(page, runtime());
  f.publishVoice({
    configured: true,
    status: 'ready',
    allowVoiceSubmit: true,
    deviceToolsReady: true,
  });
  const context = page.getByRole('button', { name: '上下文使用详情', exact: true });
  const voice = page.locator('.voice-handoff-menu');
  const voiceDetails = page.locator('.voice-handoff-details');
  await expect(voice.locator(':scope > summary')).toHaveText('语音执行已开启');
  await context.click();
  await expect(context).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('table')).toBeVisible();

  await voice.locator(':scope > summary').click();
  await expect(voiceDetails).toBeVisible();
  await expect(context).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('table')).not.toBeVisible();
  await expect(voice.locator('.voice-handoff-chevron')).toHaveCSS(
    'transform',
    'matrix(-1, 0, 0, -1, 0, 0)',
  );
  expect(f.voiceCommands).toContainEqual({ action: 'context-details', open: false });

  await context.click();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(voiceDetails).not.toBeVisible();
  f.publishVoice({
    handoff: {
      captureId: randomUUID(),
      status: 'unhandled',
      message: '本次语音尚未交给 Codex，请检查连接后重试。',
      taskId: null,
    },
  });
  await expect(voice.locator(':scope > summary')).toHaveText('未交给 Codex');
  await expect(voiceDetails).toBeVisible();
  await expect(voiceDetails).toContainText('本次语音尚未交给 Codex，请检查连接后重试。');
  await expect(context).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('table')).not.toBeVisible();

  const contextCommands = f.voiceCommands.filter((command) => command.action === 'context-details');
  f.publishVoice({ contextDetailsOpen: true });
  await expect(context).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('table')).toBeVisible();
  await expect(voiceDetails).not.toBeVisible();
  await expect(voice.locator(':scope > summary')).toHaveText('未交给 Codex');
  expect(f.voiceCommands.filter((command) => command.action === 'context-details')).toEqual(
    contextCommands,
  );
  await page.keyboard.press('Escape');
  await expect(context).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('table')).not.toBeVisible();
  await expect(context).toBeFocused();
  await context.click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('heading', { name: '项目预览', exact: true }).click();
  await expect(context).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('table')).not.toBeVisible();

  const voiceTrigger = voice.locator(':scope > summary');
  await voiceTrigger.click();
  await expect(voiceDetails).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(voiceDetails).not.toBeVisible();
  await expect(voiceTrigger).toBeFocused();
  await voiceTrigger.click();
  await expect(voiceDetails).toBeVisible();
  await page.getByRole('heading', { name: '项目预览', exact: true }).click();
  await expect(voiceDetails).not.toBeVisible();
  expect(f.commands).toHaveLength(0);
  expect(f.contexts).toHaveLength(0);
});

test('long voice captions and errors scroll without displacing the footer action row', async ({
  page,
}) => {
  const f = await open(page, runtime());
  const footer = page.locator('.live-footer');
  const subtitle = `${'正在播报完整的共创回复。\n'.repeat(30)}字幕最后一行仍可阅读。`;
  const error = `${'语音连接提示：请检查后重试。\n'.repeat(30)}错误最后一行仍可阅读。`;
  for (const width of [998, 759]) {
    await page.setViewportSize({ width, height: 767 });
    f.publishVoice({
      configured: true,
      status: 'ready',
      conversationActive: false,
      subtitle: '',
      error: null,
    });
    await expect(footer.locator('.voice-subtitle')).not.toBeVisible();
    await expect(footer.locator('.voice-controls > p[role="alert"]')).not.toBeVisible();
    const beforeFooter = await footer.boundingBox();
    const beforeAction = await page
      .getByRole('button', { name: '开始收音', exact: true })
      .boundingBox();
    if (!beforeFooter || !beforeAction) throw new Error('Idle voice controls are missing');

    f.publishVoice({
      status: 'speaking',
      conversationActive: true,
      captureId: randomUUID(),
      subtitle,
      error,
    });
    const caption = footer.locator('.voice-subtitle');
    const notice = footer.locator('.voice-controls > p[role="alert"]');
    await expect(caption).toHaveText(subtitle);
    await expect(notice).toHaveText(error);
    const afterFooter = await footer.boundingBox();
    if (!afterFooter) throw new Error('Footer is missing');
    expect(afterFooter.y + afterFooter.height).toBeLessThanOrEqual(768);
    for (const text of [caption, notice]) {
      const bounds = await text.boundingBox();
      if (!bounds) throw new Error('Scrollable voice text is missing');
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(afterFooter.y + afterFooter.height);
      const metrics = await text.evaluate((element) => ({
        height: element.clientHeight,
        content: element.scrollHeight,
        font: Number.parseFloat(getComputedStyle(element).fontSize),
        overflow: getComputedStyle(element).overflowY,
      }));
      expect(metrics.height).toBeLessThanOrEqual(Math.min(76.7, metrics.font * 4.8) + 1);
      expect(metrics.content).toBeGreaterThan(metrics.height);
      expect(metrics.overflow).toBe('auto');
      await text.hover();
      await page.mouse.wheel(0, 2000);
      await expect.poll(() => text.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await expect
        .poll(() =>
          text.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
    }
    const keyboard = await page
      .getByRole('button', { name: '文字输入', exact: true })
      .boundingBox();
    const close = await page.getByRole('button', { name: '关闭语音', exact: true }).boundingBox();
    const stop = await page.getByRole('button', { name: '停止播报', exact: true }).boundingBox();
    if (!keyboard || !close || !stop) throw new Error('Active voice controls are missing');
    expect(Math.abs(keyboard.y - close.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(keyboard.y - stop.y)).toBeLessThanOrEqual(2);
    expect(
      Math.abs(keyboard.y - afterFooter.y - (beforeAction.y - beforeFooter.y)),
    ).toBeLessThanOrEqual(2);
  }
});
