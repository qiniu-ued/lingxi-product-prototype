import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PreviewBinding, WorkbenchState } from '@lingxi/protocol';
import { afterEach, expect, it } from 'vitest';
import { CodexSetup } from './codex-setup.js';
import { Workbench } from './workbench.js';
import { WorkbenchStore } from './workbench-store.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function create(mode = 'success', publish = true) {
  const root = await mkdtemp(join(tmpdir(), 'lingxi-task-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = { id: randomUUID(), name: 'Test', path: root };
  const binding: PreviewBinding = {
    id: randomUUID(),
    projectId: project.id,
    revision: 1,
    epoch: 1,
    url: 'lingxi-preview://test/index.html',
    title: 'Test',
  };
  const record = join(root, 'messages.jsonl');
  const wb = new Workbench({
    databasePath: join(root, 'db.sqlite'),
    codex: new CodexSetup({ toolsRoot: root }),
    desktop: {
      async call() {
        if (!publish) throw new Error('no entry');
        return binding;
      },
    },
    mcpToken: 'private',
    executable: process.execPath,
    prefixArgs: [
      fileURLToPath(new URL('../../../tests/fixtures/codex-task.mjs', import.meta.url)),
      mode,
      record,
    ],
    timeoutMs:
      mode === 'hang' || mode.startsWith('settings-') ? 150 : mode === 'steer-timeout' ? 800 : 5000,
  });
  cleanup.push(() => wb.close());
  wb.setAddress('http://127.0.0.1:1234');
  wb.setProject(project);
  return { wb, root, project, binding, record };
}
async function until(wb: Workbench, predicate: (state: WorkbenchState) => boolean) {
  for (let i = 0; i < 300; i++) {
    if (predicate(wb.read())) return wb.read();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for task');
}
it('keeps one real child connection across turns, streams matching events, publishes and deduplicates', async () => {
  const { wb, project, binding, record } = await create();
  const id = randomUUID();
  const changes: number[] = [];
  const off = wb.subscribe((state) => changes.push(state.revision));
  wb.start(id, '做一个页面');
  expect(wb.start(id, '做一个页面').id).toBe(id);
  expect(() => wb.start(id, 'different')).toThrow('request_conflict');
  expect(() => wb.start(randomUUID(), 'another')).toThrow('task_running');
  expect(() => wb.setProject(project)).toThrow('task_running');
  await until(wb, (s) => s.task?.status === 'completed');
  expect(wb.read().task?.messages).toEqual([{ id: 'message-1', text: '本轮已完成' }]);
  expect(wb.read().preview).toEqual(binding);
  expect(wb.start(id, '做一个页面').status).toBe('completed');
  await new Promise((resolve) => setTimeout(resolve, 10));
  wb.start(randomUUID(), '修改');
  await until(wb, (s) => s.task?.status === 'completed');
  off();
  const records = (await readFile(record, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records.filter((r) => r.method === 'initialize')).toHaveLength(1);
  expect(records.filter((r) => r.method === 'thread/start')).toHaveLength(1);
  expect(wb.read().history).toHaveLength(2);
  expect(wb.read().task?.diff).toContain('+new');
  expect(records.find((r) => r.method === 'thread/start').params).toMatchObject({
    cwd: project.path,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
  });
  expect(changes.length).toBeGreaterThan(5);
  for (const r of records.filter((r) => r.pid)) expect(() => process.kill(r.pid, 0)).not.toThrow();
  await wb.close();
  for (const r of records.filter((r) => r.pid)) expect(() => process.kill(r.pid, 0)).toThrow();
});
it.each(['approval', 'file', 'question'])(
  'waits for explicit %s decisions and rejects stale approvals',
  async (mode) => {
    const { wb } = await create(mode);
    wb.start(randomUUID(), 'change');
    await until(wb, (s) => s.task?.status === 'waiting');
    const task = wb.read().task;
    if (!task?.approval) throw new Error('missing approval');
    expect(() => wb.decide({ taskId: task.id, approvalId: 'stale', decision: 'accept' })).toThrow(
      'approval_stale',
    );
    if (mode === 'question')
      expect(() =>
        wb.decide({ taskId: task.id, approvalId: task.approval?.id ?? '', decision: 'accept' }),
      ).toThrow('answers_required');
    wb.decide({
      taskId: task.id,
      approvalId: task.approval.id,
      decision: 'accept',
      ...(mode === 'question' ? { answers: { color: '蓝色' } } : {}),
    });
    await until(wb, (s) => s.task?.status === 'completed');
  },
);
it.each(['wait', 'question'])('interrupts %s and preserves honest state', async (mode) => {
  const { wb } = await create(mode);
  wb.start(randomUUID(), 'wait');
  await until(wb, (s) => s.task?.status === (mode === 'question' ? 'waiting' : 'running'));
  const task = wb.read().task;
  if (mode === 'question' && task?.approval)
    wb.decide({ taskId: task.id, approvalId: task.approval.id, decision: 'decline' });
  else wb.interrupt();
  await until(wb, (s) => s.task?.status === 'interrupted');
  expect(wb.read().preview).toBeNull();
  wb.interrupt();
});
it.each(['rpc-error', 'failed', 'hang'])(
  'bounds %s failures and never reports simulated success',
  async (mode) => {
    const { wb } = await create(mode);
    wb.start(randomUUID(), 'work');
    await until(wb, (s) => s.task?.status === 'failed');
    expect(wb.read().task?.error).not.toContain('PRIVATE');
    expect(wb.read().preview).toBeNull();
  },
);
it('allows completed work without a preview and rejects a different project binding', async () => {
  const { wb, binding } = await create('success', false);
  wb.start(randomUUID(), 'work');
  await until(wb, (s) => s.task?.status === 'completed');
  expect(wb.read().task?.activity).toContain('尚未生成');
  expect(() => wb.setPreview({ ...binding, projectId: randomUUID() })).toThrow('project_changed');
});
it('rejects old selected targets and keeps request receipts across restart', async () => {
  const { wb, binding, root, project } = await create();
  wb.setPreview(binding);
  const selection = { binding: { ...binding, epoch: 0 }, ref: 'r1', description: '标题' };
  expect(() => wb.start(randomUUID(), 'change', selection)).toThrow('selection_stale');
  const id = randomUUID();
  wb.start(id, 'once', { ...selection, binding });
  await until(wb, (s) => s.task?.status === 'completed');
  await wb.close();
  const next = new Workbench({
    databasePath: join(root, 'db.sqlite'),
    codex: new CodexSetup({ toolsRoot: root }),
    desktop: {
      async call() {
        throw new Error('Must not execute');
      },
    },
    mcpToken: '',
  });
  cleanup.push(() => next.close());
  next.setProject(project);
  expect(next.start(id, 'once', { ...selection, binding }).status).toBe('completed');
  expect(next.read().task?.id).toBe(id);
  expect(() => next.start(id, 'changed')).toThrow('request_conflict');
});
it('recovers unfinished persisted tasks as interrupted without automatically resuming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingxi-recovery-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.db');
  const store = new WorkbenchStore(path);
  const state = store.read();
  state.task = {
    id: randomUUID(),
    projectId: randomUUID(),
    prompt: 'work',
    selection: null,
    status: 'running',
    threadId: 'thread',
    turnId: 'turn',
    messages: [],
    activity: 'running',
    approval: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.write(state);
  store.close();
  const wb = new Workbench({
    databasePath: path,
    codex: new CodexSetup({ toolsRoot: root }),
    mcpToken: '',
  });
  cleanup.push(() => wb.close());
  expect(wb.read().task?.status).toBe('interrupted');
  expect(() => wb.start(randomUUID(), 'work')).toThrow('project_required');
});
it('preserves concurrent questions/options, answers each RPC, and resolves them independently', async () => {
  const { wb, record } = await create('rich');
  wb.start(randomUUID(), 'ask-many');
  await until(wb, (s) => s.task?.approvals?.length === 2);
  const task = wb.read().task as NonNullable<WorkbenchState['task']>;
  expect(task.approvals?.[0]?.questions?.[0]?.options?.[0]).toEqual({
    label: '蓝色',
    description: '清爽',
  });
  const first = task.approvals?.[0],
    second = task.approvals?.[1];
  if (!first || !second) throw new Error('questions missing');
  wb.decide({
    taskId: task.id,
    approvalId: first.id,
    decision: 'accept',
    answers: { color: '绿色' },
  });
  expect(wb.read().task?.approval?.id).toBe(second.id);
  wb.decide({
    taskId: task.id,
    approvalId: second.id,
    decision: 'accept',
    answers: { layout: '两栏' },
  });
  await until(wb, (s) => s.task?.status === 'completed');
  const wire = await readFile(record, 'utf8');
  expect(wire).toContain('"answers":["绿色"]');
  expect(wire).toContain('"answers":["两栏"]');
});
it('queues durable turns, steers the matching active turn, cancels queues and never loses context', async () => {
  const { wb, record } = await create('rich');
  const first = randomUUID(),
    queued = randomUUID(),
    cancelled = randomUUID();
  wb.start(first, 'hold');
  await until(wb, (s) => s.task?.status === 'running');
  const context = [{ id: randomUUID(), kind: 'diff' as const, title: 'Review', text: '+ heading' }];
  wb.start(queued, 'next', null, context, 'queue');
  wb.start(cancelled, 'cancel me', null, [], 'queue');
  await wb.command({ action: 'cancel-queued', id: cancelled });
  await expect(wb.command({ action: 'cancel-queued', id: cancelled })).rejects.toThrow(
    'queue_stale',
  );
  const steer = randomUUID();
  await wb.steer(steer, 'finish', null, context);
  await until(wb, (s) => s.task?.id === queued && s.task.status === 'completed');
  expect(wb.read().history.map((t) => t.status)).toEqual(['completed', 'completed', 'interrupted']);
  expect(wb.read().history[0]?.additions).toMatchObject([
    { id: steer, text: 'finish', status: 'acknowledged' },
  ]);
  await wb.steer(steer, 'finish', null, context);
  await expect(wb.steer(steer, 'different', null, context)).rejects.toThrow('request_conflict');
  expect(await readFile(record, 'utf8')).toContain('expectedTurnId');
  expect(await readFile(record, 'utf8')).toContain('user_context');
  await expect(wb.steer(randomUUID(), 'late', null, [])).rejects.toThrow('turn_unavailable');
});
it('switches durable histories, forks at completed turns, and makes Sidechat read only', async () => {
  const { wb, record, project } = await create('rich');
  wb.start(randomUUID(), 'first');
  await until(wb, (s) => s.task?.status === 'completed');
  const original = wb.read().selectedThreadId as string,
    task = wb.read().task as NonNullable<WorkbenchState['task']>;
  await wb.command({ action: 'fork', taskId: task.id, kind: 'sidechat' });
  const side = wb.read().selectedThreadId as string;
  expect(wb.read().history).toEqual([]);
  await expect(wb.terminal({ action: 'open', requestId: randomUUID() })).rejects.toThrow(
    'readonly_sidechat',
  );
  wb.start(randomUUID(), 'explain');
  await until(wb, (s) => s.task?.status === 'completed');
  expect(wb.read().threads.find((t) => t.id === side)?.parentId).toBe(original);
  await wb.command({ action: 'rename-thread', id: side, title: '讨论结论' });
  await wb.command({ action: 'archive-thread', id: side, archived: true });
  await wb.command({ action: 'select-thread', id: original });
  expect(wb.read().history).toHaveLength(1);
  await wb.command({ action: 'fork', taskId: task.id, kind: 'fork' });
  expect(wb.read().threads.at(-1)?.kind).toBe('fork');
  await wb.command({ action: 'new-thread', title: '另一个问题' });
  expect(wb.read().task).toBeNull();
  await wb.command({
    action: 'settings',
    settings: { model: 'test-model', effort: 'high', plan: true },
  });
  wb.start(randomUUID(), 'plan');
  await until(wb, (s) => s.task?.status === 'completed');
  const catalog = await wb.catalog();
  expect(catalog.models).toHaveProperty('data');
  const records = (await readFile(record, 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  expect(
    records.find((r) => r.method === 'turn/start' && r.params.disabledPluginIds)?.params
      .disabledPluginIds,
  ).toEqual(['fixture-plugin']);
  expect(records.find((r) => r.method === 'thread/fork').params).toMatchObject({
    sandbox: 'read-only',
    approvalPolicy: 'never',
    config: {
      'mcp_servers.lingxi_preview.enabled': false,
      'mcp_servers.second_page_tools.enabled': false,
    },
  });
  expect(records.filter((r) => r.method === 'turn/start').at(-1).params).toMatchObject({
    model: 'test-model',
    effort: 'high',
  });
  expect(records.filter((r) => r.method === 'turn/start').at(-1).params).toMatchObject({
    input: [{ type: 'text', text: 'plan' }],
    collaborationMode: {
      mode: 'plan',
      settings: { model: 'test-model', reasoning_effort: 'high', developer_instructions: null },
    },
  });
  await expect(wb.command({ action: 'select-thread', id: randomUUID() })).rejects.toThrow(
    'thread_unavailable',
  );
  await expect(wb.command({ action: 'fork', taskId: randomUUID(), kind: 'fork' })).rejects.toThrow(
    'fork_unavailable',
  );
  wb.setProject(project);
  wb.start(randomUUID(), 'resumed');
  await until(wb, (s) => s.task?.status === 'completed');
  expect(await readFile(record, 'utf8')).toContain('thread/resume');
});
it('owns a persistent PTY independently of turns, and rejects stale PTY IDs', async () => {
  const { wb, record } = await create('rich');
  const id = randomUUID();
  await wb.terminal({ action: 'open', requestId: id });
  await until(wb, (s) => s.terminal?.status === 'running');
  await wb.terminal({ action: 'open', requestId: id });
  await expect(wb.terminal({ action: 'open', requestId: randomUUID() })).rejects.toThrow(
    'terminal_running',
  );
  await expect(wb.terminal({ action: 'write', id: randomUUID(), data: 'bad' })).rejects.toThrow(
    'terminal_stale',
  );
  await wb.terminal({ action: 'write', id, data: 'pwd\r' });
  await wb.terminal({ action: 'resize', id, cols: 120, rows: 30 });
  wb.start(randomUUID(), 'task');
  await until(wb, (s) => s.task?.status === 'completed');
  expect(wb.read().terminal?.status).toBe('running');
  await wb.terminal({ action: 'stop', id });
  await until(wb, (s) => s.terminal?.status === 'exited');
  expect(wb.read().terminal?.exitCode).toBe(0);
  expect(await readFile(record, 'utf8')).toContain(Buffer.from('pwd\r').toString('base64'));
});
it('reserves supplemental input before dispatch and never repeats an uncertain delivery', async () => {
  const { wb, record } = await create('steer-timeout');
  wb.start(randomUUID(), 'hold');
  await until(wb, (state) => state.task?.status === 'running');
  const id = randomUUID();
  await expect(wb.steer(id, 'unconfirmed', null, [])).rejects.toThrow();
  expect(wb.read().task?.additions?.[0]?.status).toBe('unconfirmed');
  await expect(wb.steer(id, 'unconfirmed', null, [])).rejects.toThrow('steer_unconfirmed');
  expect(() => wb.start(id, 'unconfirmed')).toThrow('request_conflict');
  const wire = (await readFile(record, 'utf8'))
    .split('\n')
    .filter((line) => line.includes('"method":"turn/steer"'));
  expect(wire).toHaveLength(1);
});
it('explicitly terminates a still-running PTY before closing its Codex connection', async () => {
  const { wb, record } = await create('rich');
  const id = randomUUID();
  await wb.terminal({ action: 'open', requestId: id });
  await until(wb, (state) => state.terminal?.status === 'running');
  await wb.close();
  const messages = (await readFile(record, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(
    messages.find((message) => message.method === 'command/exec/terminate').params.processId,
  ).toBe(id);
  for (const message of messages.filter((message) => message.pid))
    expect(() => process.kill(message.pid, 0)).toThrow();
});
it('captures voice context once without retargeting staged annotations to another conversation', async () => {
  const { wb, project, binding } = await create('rich');
  wb.setPreview(binding);
  const selection = { binding, ref: 'r1', description: '标题' };
  const attachment = { id: randomUUID(), kind: 'diff' as const, title: '变更', text: '+ heading' };
  const input = {
    projectId: project.id,
    conversationId: null,
    selection,
    attachments: [attachment],
    text: '标题写周末出游',
  };
  wb.setVoiceContext(input);
  expect(wb.voiceContext()).toMatchObject({
    selection,
    attachments: [attachment, { title: '键盘草稿', text: input.text }],
  });
  expect(wb.voiceContext()).toEqual({ selection: null, attachments: [] });
  wb.setVoiceContext(input);
  await wb.command({ action: 'new-thread', title: 'different conversation' });
  expect(() => wb.voiceContext()).toThrow('voice_context_changed');
  expect(() => wb.setVoiceContext(input)).toThrow('project_changed');
  expect(() => wb.setVoiceContext({ ...input, projectId: randomUUID() })).toThrow(
    'project_changed',
  );
  expect(() =>
    wb.setVoiceContext({
      ...input,
      conversationId: wb.read().selectedThreadId,
      attachments: Array(20).fill(attachment),
    }),
  ).toThrow('context_limit');
});
it('reads all visible models without creating a thread or turn', async () => {
  const { wb, record, project } = await create('rich');
  const models = await wb.models();
  expect(models.projectId).toBe(project.id);
  expect(models.data.map((model) => model.model)).toEqual(['test-model', 'fast-model']);
  expect(models.data[1]?.supportedReasoningEfforts.map((e) => e.reasoningEffort)).toEqual(['low']);
  const wire = await readFile(record, 'utf8');
  expect(wire).toContain('"cursor":"models2"');
  expect(wire).not.toContain('thread/start');
  expect(wire).not.toContain('turn/start');
  expect(wb.read().task).toBeNull();
});
it.each(['model-error', 'model-cycle'])(
  'bounds %s model discovery without starting tasks',
  async (mode) => {
    const { wb } = await create(mode);
    await expect(wb.models()).rejects.toThrow();
    expect(wb.read().task).toBeNull();
  },
);
it('tracks current context separately from cumulative tokens, including fast and late reports, and restores it', async () => {
  const { wb, root } = await create('telemetry');
  const samples: number[] = [];
  wb.subscribe((state) => {
    if (state.runtime?.usage) samples.push(state.runtime.usage.last.totalTokens);
  });
  wb.start(randomUUID(), 'observe tokens');
  await until(
    wb,
    (state) =>
      state.task?.status === 'completed' && state.runtime?.usage?.last.totalTokens === 32000,
  );
  expect(samples).toContain(64000);
  expect(samples).toContain(32000);
  expect(samples).not.toContain(96000);
  expect(samples).not.toContain(-1);
  const runtime = wb.read().runtime;
  expect(runtime).toMatchObject({
    model: 'test-model',
    effort: 'medium',
    usage: {
      modelContextWindow: 128000,
      last: {
        totalTokens: 32000,
        cachedInputTokens: 12000,
        cacheWriteInputTokens: 1000,
        reasoningOutputTokens: 800,
      },
      total: { totalTokens: 150000 },
    },
  });
  await wb.close();
  const next = new Workbench({
    databasePath: join(root, 'db.sqlite'),
    codex: new CodexSetup({ toolsRoot: root }),
    mcpToken: '',
  });
  cleanup.push(() => next.close());
  expect(next.read().runtime).toEqual(runtime);
});
it('keeps unknown window capacity unknown and isolates new/forked conversation usage', async () => {
  const { wb } = await create('usage-unknown');
  wb.start(randomUUID(), 'unknown capacity');
  await until(wb, (state) => state.runtime?.usage !== null && state.runtime?.usage !== undefined);
  expect(wb.read().runtime?.usage?.modelContextWindow).toBeNull();
  const original = wb.read().selectedThreadId as string,
    task = wb.read().task as NonNullable<WorkbenchState['task']>;
  await wb.command({ action: 'fork', taskId: task.id, kind: 'fork' });
  expect(wb.read().runtime?.usage ?? null).toBeNull();
  await wb.command({ action: 'new-thread', title: 'Empty' });
  expect(wb.read().runtime).toBeNull();
  await wb.command({ action: 'select-thread', id: original });
  expect(wb.read().runtime?.usage?.last.totalTokens).toBe(32000);
});
it.each(['turn-usage', 'turn-usage-late'])(
  'keeps per-turn consumption across multiple requests, duplicates, queueing, late reports and restart (%s)',
  async (mode) => {
    const { wb, root } = await create(mode);
    const first = randomUUID(),
      second = randomUUID();
    wb.start(first, 'first round');
    wb.start(second, 'second round', null, [], 'queue');
    await until(
      wb,
      (state) =>
        state.task?.id === second &&
        state.task.status === 'completed' &&
        state.runtime?.usage?.total.totalTokens === 480 &&
        state.turnUsage.find((usage) => usage.taskId === first)?.tokens?.totalTokens === 240,
    );
    const usage = wb.read().turnUsage;
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      taskId: first,
      status: 'reported',
      tokens: {
        totalTokens: 240,
        inputTokens: 200,
        cachedInputTokens: 100,
        outputTokens: 40,
      },
    });
    expect(usage[1]).toMatchObject({
      taskId: second,
      status: 'reported',
      tokens: {
        totalTokens: 240,
        inputTokens: 200,
        cachedInputTokens: 80,
        outputTokens: 40,
      },
    });
    expect(wb.read().runtime?.usage?.last.totalTokens).toBe(120);
    expect(wb.read().runtime?.usage?.total.totalTokens).toBe(480);
    await wb.close();
    const next = new Workbench({
      databasePath: join(root, 'db.sqlite'),
      codex: new CodexSetup({ toolsRoot: root }),
      mcpToken: '',
    });
    cleanup.push(() => next.close());
    expect(next.read().turnUsage).toEqual(usage);
  },
);
it('does not turn missing reports into zero consumption or reuse a fork parent baseline', async () => {
  const { wb } = await create('turn-usage-missing');
  const first = randomUUID(),
    second = randomUUID();
  wb.start(first, 'no usage report');
  wb.start(second, 'missing baseline', null, [], 'queue');
  await until(
    wb,
    (state) =>
      state.task?.id === second &&
      state.task.status === 'completed' &&
      state.runtime?.usage?.total.totalTokens === 480,
  );
  expect(wb.read().turnUsage.map((u) => [u.status, u.tokens])).toEqual([
    ['waiting', null],
    ['baseline-missing', null],
  ]);
  const original = wb.read().selectedThreadId as string;
  await wb.command({ action: 'fork', taskId: second, kind: 'fork' });
  expect(wb.read().turnUsage).toEqual([]);
  wb.start(randomUUID(), 'fork round');
  await until(wb, (state) => state.task?.status === 'completed' && !!state.turnUsage[0]?.updatedAt);
  expect(wb.read().turnUsage[0]).toMatchObject({ status: 'baseline-missing', tokens: null });
  await wb.command({ action: 'select-thread', id: original });
  expect(wb.read().turnUsage).toHaveLength(2);
});
it('marks a decrease in cumulative counters unavailable instead of showing a smaller completed bill', async () => {
  const { wb } = await create('turn-usage-reset');
  wb.start(randomUUID(), 'reset cumulative counters');
  await until(wb, (state) => state.turnUsage[0]?.status === 'counter-reset');
  expect(wb.read().task?.status).toBe('completed');
  expect(wb.read().turnUsage[0]?.tokens).toBeNull();
});
it('discovers execution capabilities without starting a thread and verifies on an isolated non-model session', async () => {
  const { wb, record } = await create();
  expect(await wb.executionOptions()).toMatchObject({
    plan: true,
    permissions: { manual: true, 'auto-review': true, 'full-access': true },
  });
  expect(await readFile(record, 'utf8')).not.toContain('thread/start');
  const before = wb.read();
  expect((await wb.verifyExecution()).verified).toEqual([
    'plan',
    'default',
    'manual',
    'auto-review',
    'full-access',
  ]);
  expect(wb.read()).toEqual(before);
  const wire = await readFile(record, 'utf8');
  expect(wire).toContain('"ephemeral":true');
  expect(wire).not.toContain('turn/start');
});
it('captures Plan and permissions when queueing and explicitly restores default mode on the next turn', async () => {
  const { wb, record, project } = await create('rich');
  await wb.command({ action: 'set-permission', permission: 'auto-review' });
  wb.start(randomUUID(), 'hold');
  await until(wb, (s) => s.task?.status === 'running');
  await wb.command({ action: 'set-mode', mode: 'plan' });
  await wb.command({ action: 'set-permission', permission: 'full-access' });
  const queued = randomUUID();
  wb.start(queued, 'plan next', null, [], 'queue');
  await wb.command({ action: 'set-mode', mode: 'default' });
  await wb.command({ action: 'set-permission', permission: 'manual' });
  await wb.steer(randomUUID(), 'finish', null, []);
  await until(wb, (s) => s.task?.id === queued && s.task.status === 'completed');
  wb.start(randomUUID(), 'execute next', null, [], 'queue');
  await until(wb, (s) => s.task?.prompt === 'execute next' && s.task.status === 'completed');
  const turns = (await readFile(record, 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s))
    .filter((r) => r.method === 'turn/start');
  expect(turns[0].params).toMatchObject({
    approvalsReviewer: 'auto_review',
    approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [project.path], networkAccess: false },
    collaborationMode: { mode: 'default' },
  });
  expect(turns[1].params).toMatchObject({
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
    collaborationMode: { mode: 'plan' },
  });
  expect(turns[1].params.input[0].text).toBe('plan next');
  expect(turns[2].params).toMatchObject({
    approvalsReviewer: 'user',
    approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'workspaceWrite' },
    collaborationMode: { mode: 'default' },
  });
});
it.each(['default', 'plan'] as const)(
  'starts a real child turn in %s mode when the CLI omits its implicit cwd root',
  async (mode) => {
    const { wb, record } = await create('implicit-cwd');
    await wb.command({ action: 'set-mode', mode });
    wb.start(randomUUID(), 'check implicit workspace root');
    await until(wb, (s) => s.task?.status === 'completed');
    const wire = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(wire.find((r) => r.method === 'turn/start').params.collaborationMode.mode).toBe(mode);
  },
);
it.each([
  'no-modes',
  'settings-error',
  'settings-mismatch',
  'settings-wrong-cwd',
  'settings-extra-root',
])('does not call a model after unsupported or unconfirmed settings (%s)', async (mode) => {
  const { wb, record } = await create(mode);
  wb.start(randomUUID(), 'do work');
  await until(wb, (s) => s.task?.status === 'failed');
  expect(await readFile(record, 'utf8')).not.toContain('turn/start');
  expect(JSON.stringify(wb.read())).not.toContain('PRIVATE');
});
it('respects managed restrictions and rejects a voice mode change whose context expired while checking', async () => {
  const { wb } = await create('restricted');
  expect((await wb.executionOptions()).permissions).toEqual({
    manual: true,
    'auto-review': false,
    'full-access': false,
  });
  await expect(wb.command({ action: 'set-permission', permission: 'full-access' })).rejects.toThrow(
    'execution_not_supported',
  );
  await expect(wb.command({ action: 'set-mode', mode: 'plan' }, () => false)).rejects.toThrow(
    'voice_context_changed',
  );
  expect(wb.read().permission).toBe('manual');
  expect(wb.read().settings.plan).toBe(false);
});
it('keeps execution available when the CLI supports Default but not Plan', async () => {
  const { wb } = await create('default-only');
  expect(await wb.executionOptions()).toMatchObject({ plan: false, defaultMode: true });
  await expect(wb.command({ action: 'set-mode', mode: 'plan' })).rejects.toThrow(
    'execution_not_supported',
  );
  wb.start(randomUUID(), 'execute normally');
  await until(wb, (s) => s.task?.status === 'completed');
});
it('shows actual automatic review denial and keeps Sidechat read-only under a Full Access preference', async () => {
  const { wb, record } = await create('review-denied');
  await wb.command({ action: 'set-permission', permission: 'auto-review' });
  wb.start(randomUUID(), 'review action');
  await until(wb, (s) => s.task?.status === 'completed');
  expect(wb.read().task?.items).toContainEqual(
    expect.objectContaining({ type: '自动审批审查', status: '已拒绝' }),
  );
  const task = wb.read().task as NonNullable<WorkbenchState['task']>;
  await wb.command({ action: 'set-permission', permission: 'full-access' });
  await wb.command({ action: 'fork', taskId: task.id, kind: 'sidechat' });
  wb.start(randomUUID(), 'discuss');
  await until(wb, (s) => s.task?.status === 'completed');
  const turns = (await readFile(record, 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s))
    .filter((r) => r.method === 'turn/start');
  expect(turns.at(-1).params).toMatchObject({
    approvalsReviewer: 'user',
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  });
});
