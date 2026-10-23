import { timingSafeEqual } from 'node:crypto';
import {
  desktopActionSchema,
  previewActionSchema,
  previewSnapshotSchema,
  startTaskSchema,
  taskDecisionSchema,
} from '@lingxi/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DesktopBridge } from './desktop-bridge.js';
import type { Workbench } from './workbench.js';

export function workbenchRoutes(
  app: FastifyInstance,
  workbench: Workbench,
  desktop: DesktopBridge | undefined,
  token: string,
) {
  const streams = new Set<() => void>();
  app.get('/api/workbench', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return workbench.read();
  });
  app.get('/api/workbench/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const send = () =>
      reply.raw.write(`event: workbench.snapshot\ndata: ${JSON.stringify(workbench.read())}\n\n`);
    const unsubscribe = workbench.subscribe(send);
    send();
    const timer = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000);
    timer.unref();
    const end = () => reply.raw.end();
    streams.add(end);
    reply.raw.on('close', () => {
      unsubscribe();
      clearInterval(timer);
      streams.delete(end);
    });
    request.raw.on('error', () => reply.raw.destroy());
  });
  app.addHook('preClose', async () => {
    for (const end of streams) end();
    await workbench.close();
  });
  app.post('/api/workbench/:operation', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!request.headers.origin) return reply.code(403).send({ error: 'forbidden_origin' });
    const operation = z
      .object({ operation: z.enum(['start', 'interrupt', 'decision', 'action']) })
      .safeParse(request.params);
    if (!operation.success) return reply.code(404).send({ error: 'not_found' });
    try {
      switch (operation.data.operation) {
        case 'start': {
          const input = startTaskSchema.parse(request.body);
          workbench.start(input.requestId, input.text, input.selection ?? null);
          break;
        }
        case 'interrupt':
          z.strictObject({}).parse(request.body);
          workbench.interrupt();
          break;
        case 'decision':
          workbench.decide(taskDecisionSchema.parse(request.body));
          break;
        case 'action': {
          const input = desktopActionSchema.parse(request.body);
          if (!desktop) throw new Error('desktop_required');
          if (input.action === 'publish-preview') await workbench.publish();
          else {
            if (
              (input.action === 'select-project' || input.action === 'new-project') &&
              workbench.read().task &&
              !['completed', 'failed', 'interrupted'].includes(workbench.read().task?.status ?? '')
            )
              throw new Error('task_running');
            const result = await desktop.call('action', input);
            if (result && (input.action === 'select-project' || input.action === 'new-project'))
              workbench.setProject(result);
          }
          break;
        }
      }
      return workbench.read();
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request' });
      return reply.code(409).send({ error: 'operation_unavailable' });
    }
  });
  // Dedicated, authenticated, stateless MCP endpoint. It cannot forward arbitrary browser RPC.
  app.post('/mcp/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const supplied = request.headers.authorization ?? '';
    const expected = `Bearer ${token}`;
    if (
      !desktop ||
      !token ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      return reply.code(401).send({ error: 'unauthorized' });
    const parsed = z
      .object({
        jsonrpc: z.literal('2.0'),
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z.unknown().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { id, method, params } = parsed.data;
    if (id === undefined) return reply.code(202).send();
    let result: unknown;
    if (method === 'initialize')
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'lingxi-visible-preview', version: '0.1.0' },
      };
    else if (method === 'ping') result = {};
    else if (method === 'tools/list')
      result = {
        tools: [
          {
            name: 'preview',
            description:
              'Read or operate the exact visible product page. First snapshot to obtain binding and element refs. Re-snapshot after navigation or a stale reference. Actions never execute a shell or arbitrary JavaScript.',
            inputSchema: z.toJSONSchema(previewActionSchema),
          },
        ],
      };
    else if (method === 'tools/call') {
      try {
        const input = z
          .strictObject({ name: z.literal('preview'), arguments: previewActionSchema })
          .parse(params);
        const snapshot = previewSnapshotSchema.parse(
          await desktop.call('preview', input.arguments),
        );
        workbench.setPreview(snapshot.binding);
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                binding: snapshot.binding,
                text: snapshot.text,
                width: snapshot.width,
                height: snapshot.height,
              }),
            },
            { type: 'image', data: snapshot.image, mimeType: 'image/png' },
          ],
        };
      } catch {
        result = {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Preview unavailable or stale. Take a fresh snapshot and verify the result before retrying: the action may have applied. Publish preview/index.html if no page exists.',
            },
          ],
        };
      }
    } else return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    return { jsonrpc: '2.0', id, result };
  });
}
