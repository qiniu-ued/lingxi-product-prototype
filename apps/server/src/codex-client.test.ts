import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexClient } from './codex-client.js';
import { applyExecution, executionParams } from './execution.js';

const clients: CodexClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
function create(executable = process.execPath, mode = 'rich') {
  const client = new CodexClient({
    executable,
    prefixArgs: [
      fileURLToPath(new URL('../../../tests/fixtures/codex-task.mjs', import.meta.url)),
      mode,
    ],
    cwd: '/tmp',
    timeoutMs: 300,
    onMessage() {},
    onDisconnect() {},
  });
  clients.push(client);
  return client;
}
it('multiplexes out-of-order responses and isolates request errors/timeouts from the connection', async () => {
  const client = create();
  await client.ready;
  const slow = client.request('fixture/out-of-order', { delay: 40, value: 'slow' });
  const fast = client.request('fixture/out-of-order', { delay: 1, value: 'fast' });
  expect(await fast).toMatchObject({ value: 'fast' });
  expect(await slow).toMatchObject({ value: 'slow' });
  await expect(client.request('fixture/error', {})).rejects.toThrow('codex_request_failed');
  await expect(client.request('fixture/hang', {}, 20)).rejects.toThrow('codex_request_timeout');
  expect(await client.request('model/list', {})).toHaveProperty('data');
});
it.each(['fixture/invalid', 'fixture/exit'])(
  'rejects pending requests on %s and cannot send after closure',
  async (method) => {
    const client = create();
    await client.ready;
    await expect(client.request(method, {})).rejects.toThrow('codex_disconnected');
    await expect(client.request('model/list', {})).rejects.toThrow('codex_disconnected');
  },
);
it('handles an unavailable executable without leaving a pending initialization', async () => {
  const client = create('/tmp/lingxi-nonexistent-codex');
  await expect(client.ready).rejects.toThrow('codex_disconnected');
});

function settings(threadId = 'thread-1') {
  return executionParams(
    threadId,
    { id: 'project-1', name: 'Test', path: '/tmp' },
    'manual',
    false,
    'default',
    'test-model',
    'medium',
  );
}
it('reuses confirmed settings after an acknowledged no-op and confirms actual changes again', async () => {
  const client = create(process.execPath, 'settings-noop');
  await client.ready;
  const params = settings();
  await applyExecution(client, params);
  await expect(applyExecution(client, params)).resolves.toBeUndefined();
  params.collaborationMode.mode = 'plan';
  await expect(applyExecution(client, params)).resolves.toBeUndefined();
  await expect(applyExecution(client, params)).resolves.toBeUndefined();
});
it('does not reuse a superseded confirmation or accept another thread notification', async () => {
  const client = create(process.execPath, 'settings-noop');
  await client.ready;
  const params = settings();
  await applyExecution(client, params);
  await client.request('fixture/settings-notify', {
    threadId: params.threadId,
    threadSettings: { ...params, approvalsReviewer: 'unexpected' },
  });
  await client.request('fixture/settings-notify', {
    threadId: 'another-thread',
    threadSettings: params,
  });
  await expect(applyExecution(client, params)).rejects.toThrow('execution_unconfirmed');
});
it('does not let a previous confirmation override a failed update request', async () => {
  const client = create(process.execPath, 'settings-noop');
  await client.ready;
  const params = settings();
  await applyExecution(client, params);
  vi.spyOn(client, 'request').mockRejectedValueOnce(new Error('codex_request_failed'));
  await expect(applyExecution(client, params)).rejects.toThrow('codex_request_failed');
  await expect(applyExecution(client, params)).rejects.toThrow('execution_unconfirmed');
});

it('confirms a fresh resumed client from the actual resume response before an acknowledged no-op', async () => {
  const client = create(process.execPath, 'resume-noop');
  await client.ready;
  const params = settings('resumed-thread');
  await client.request('thread/resume', { threadId: params.threadId });
  await expect(applyExecution(client, params)).resolves.toBeUndefined();
  params.collaborationMode.mode = 'plan';
  await expect(applyExecution(client, params)).resolves.toBeUndefined();
});
it.each([
  'resume-noop-missing',
  'resume-noop-mismatch',
  'resume-noop-wrong-thread',
  'resume-noop-error',
])(
  'fails closed without compatible effective settings or a successful update (%s)',
  async (mode) => {
    const client = create(process.execPath, mode);
    await client.ready;
    const params = settings('resumed-thread');
    await client.request('thread/resume', { threadId: params.threadId });
    await expect(applyExecution(client, params)).rejects.toThrow(
      mode === 'resume-noop-error' ? 'codex_request_failed' : 'execution_unconfirmed',
    );
  },
);

it.each(['model', 'effort', 'mode', 'reviewer', 'approval', 'network', 'roots'])(
  'does not treat an empty update ack as confirmation of a changed %s',
  async (field) => {
    const client = create(process.execPath, 'resume-noop-silent-change');
    await client.ready;
    const params = settings('resumed-thread');
    await client.request('thread/resume', { threadId: params.threadId });
    await expect(applyExecution(client, params)).resolves.toBeUndefined();
    if (field === 'model') params.collaborationMode.settings.model = 'different-model';
    if (field === 'effort') params.collaborationMode.settings.reasoning_effort = 'high';
    if (field === 'mode') params.collaborationMode.mode = 'plan';
    if (field === 'reviewer') params.approvalsReviewer = 'auto_review';
    if (field === 'approval') params.approvalPolicy = 'never';
    if (field === 'network') params.sandboxPolicy.networkAccess = true;
    if (field === 'roots') params.sandboxPolicy.writableRoots = ['/workspace'];
    await expect(applyExecution(client, params)).rejects.toThrow('execution_unconfirmed');
  },
);
