import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from './app.js';

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
function create(desktop = true) {
  const project = { id: randomUUID(), name: 'test', path: '/tmp' };
  const binding = {
    id: randomUUID(),
    projectId: project.id,
    revision: 1,
    epoch: 1,
    url: 'lingxi-preview://test/index.html',
    title: 'Test',
  };
  const app = buildApp({
    databasePath: ':memory:',
    mcpToken: 'private-token',
    ...(desktop
      ? {
          desktop: {
            async call(method: string, params?: unknown) {
              if (method === 'action')
                return params &&
                  typeof params === 'object' &&
                  'action' in params &&
                  params.action === 'open-display'
                  ? null
                  : project;
              if (method === 'publish') return binding;
              return {
                binding,
                text: 'r1 button Vote',
                image: 'aGVsbG8=',
                width: 100,
                height: 100,
              };
            },
          },
        }
      : {}),
  });
  apps.push(app);
  const post = (operation: string, body: unknown, origin = 'http://localhost:80') =>
    app.inject({
      method: 'POST',
      url: `/api/workbench/${operation}`,
      headers: { origin, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  const rpc = (
    method: string,
    params?: unknown,
    token = 'private-token',
    id: number | undefined = 1,
  ) =>
    app.inject({
      method: 'POST',
      url: '/mcp/preview',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        jsonrpc: '2.0',
        ...(id !== undefined ? { id } : {}),
        method,
        ...(params ? { params } : {}),
      },
    });
  return { app, project, binding, post, rpc };
}
it('keeps desktop selection native, validates origins and publishes exact bindings', async () => {
  const { app, post, project, binding } = create();
  expect((await app.inject('/api/workbench')).json().desktop).toBe(true);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/workbench/action',
        payload: { action: 'new-project' },
      })
    ).statusCode,
  ).toBe(403);
  expect((await post('action', { action: 'new-project' }, 'https://evil.example')).statusCode).toBe(
    403,
  );
  expect((await post('action', { action: 'new-project', path: '/etc' })).statusCode).toBe(400);
  expect((await post('whatever', {})).statusCode).toBe(404);
  expect((await post('start', { requestId: randomUUID(), text: 'work' })).statusCode).toBe(409);
  expect((await post('action', { action: 'select-project' })).json().project).toEqual(project);
  expect((await post('action', { action: 'publish-preview' })).json().preview).toEqual(binding);
  expect((await post('action', { action: 'open-display' })).statusCode).toBe(200);
  expect((await post('interrupt', {})).statusCode).toBe(200);
  expect(
    (await post('decision', { taskId: randomUUID(), approvalId: 'x', decision: 'accept' }))
      .statusCode,
  ).toBe(409);
  expect((await post('start', { text: '' })).statusCode).toBe(400);
});
it('authenticates MCP independently and exposes only fixed preview actions', async () => {
  const { app, rpc, post, binding } = create();
  await post('action', { action: 'select-project' });
  expect((await rpc('initialize', undefined, 'wrong')).statusCode).toBe(401);
  expect((await rpc('initialize')).json().result.capabilities.tools).toEqual({});
  expect((await rpc('tools/list')).json().result.tools[0].name).toBe('preview');
  expect((await rpc('ping')).json().result).toEqual({});
  expect((await rpc('unknown')).json().error.code).toBe(-32601);
  const snapshot = (
    await rpc('tools/call', { name: 'preview', arguments: { action: 'snapshot' } })
  ).json();
  expect(snapshot.result.content[1].type).toBe('image');
  expect((await app.inject('/api/workbench')).json().preview).toEqual(binding);
  expect(
    (await rpc('tools/call', { name: 'shell', arguments: { action: 'snapshot' } })).json().result
      .isError,
  ).toBe(true);
  expect(
    (
      await rpc('tools/call', {
        name: 'preview',
        arguments: { action: 'javascript', code: 'anything' },
      })
    ).json().result.isError,
  ).toBe(true);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/mcp/preview',
        headers: { authorization: 'Bearer private-token' },
        payload: { invalid: true },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/mcp/preview',
        headers: { authorization: 'Bearer private-token' },
        payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
      })
    ).statusCode,
  ).toBe(202);
});
it('never enables desktop tasks in a standalone browser server', async () => {
  const { post, rpc } = create(false);
  expect((await post('action', { action: 'new-project' })).statusCode).toBe(409);
  expect((await rpc('initialize')).statusCode).toBe(401);
});
it('streams full workbench snapshots and closes the stream on shutdown', async () => {
  const { app, project } = create();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/api/workbench/events`, {
    signal: AbortSignal.timeout(4000),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('no stream');
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('workbench.snapshot');
  app.workbench.setProject(project);
  const next = await reader.read();
  expect(new TextDecoder().decode(next.value)).toContain(project.id);
  await app.close();
  expect((await reader.read()).done).toBe(true);
});
