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
    timeoutMs: mode === 'hang' ? 150 : 5000,
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
it('runs and resumes a real child protocol, streams only matching events, publishes and deduplicates', async () => {
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
  expect(records.some((r) => r.method === 'thread/resume')).toBe(true);
  expect(records.find((r) => r.method === 'thread/start').params).toMatchObject({
    cwd: project.path,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
  });
  expect(changes.length).toBeGreaterThan(5);
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
  expect(next.read().task).toBeNull();
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
