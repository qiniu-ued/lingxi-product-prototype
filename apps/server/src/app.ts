import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import {
  type CodexCheck,
  codexSetupRequestSchema,
  type Session,
  submitCommandSchema,
} from '@lingxi/protocol';
import Fastify from 'fastify';
import { z } from 'zod';
import { CodexSetup } from './codex-setup.js';
import type { DesktopBridge } from './desktop-bridge.js';
import { SessionStore, StoreConflict } from './store.js';
import { Workbench } from './workbench.js';
import { workbenchRoutes } from './workbench-routes.js';

interface AppOptions {
  databasePath: string;
  webRoot?: string;
  webOrigin?: string;
  logger?: boolean;
  checkCodex?: () => Promise<CodexCheck>;
  codexSetup?: CodexSetup;
  desktop?: DesktopBridge;
  mcpToken?: string;
  taskExecutable?: string;
  taskPrefixArgs?: string[];
}

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16 * 1024 });
  const store = new SessionStore(options.databasePath);
  const setup =
    options.codexSetup ??
    new CodexSetup({
      toolsRoot: join(dirname(options.databasePath), 'tools'),
      ...(process.env.LINGXI_CODEX_BIN ? { executable: process.env.LINGXI_CODEX_BIN } : {}),
      ...(process.env.LINGXI_NPM_CLI
        ? { npmExecutable: process.execPath, npmPrefixArgs: [process.env.LINGXI_NPM_CLI] }
        : {}),
    });
  const subscribers = new Set<(snapshot: Session | null) => void>();
  const workbench = new Workbench({
    databasePath: options.databasePath,
    codex: setup,
    mcpToken: options.mcpToken ?? '',
    ...(options.desktop ? { desktop: options.desktop } : {}),
    ...(options.taskExecutable ? { executable: options.taskExecutable } : {}),
    ...(options.taskPrefixArgs ? { prefixArgs: options.taskPrefixArgs } : {}),
  });
  workbenchRoutes(app, workbench, options.desktop, options.mcpToken ?? '');
  app.addHook('onListen', async () => {
    workbench.setAddress(`http://127.0.0.1:${(app.server.address() as { port: number }).port}`);
  });

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    let hostname: string;
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      return reply.code(403).send({ error: 'forbidden_host' });
    }
    if (
      hostname !== 'localhost' &&
      !(isIP(hostname) === 4 && hostname === '127.0.0.1') &&
      hostname !== '[::1]'
    ) {
      return reply.code(403).send({ error: 'forbidden_host' });
    }
    const origin = request.headers.origin;
    const allowed = [`http://${host}`, options.webOrigin ?? 'http://127.0.0.1:5173'];
    if (origin && !allowed.includes(origin))
      return reply.code(403).send({ error: 'forbidden_origin' });
  });

  app.get('/api/health', async () => ({ status: 'ok', schemaVersion: 1 }));
  app.get('/api/session', async () => store.read());
  const environment = () => {
    return {
      checkedAt: new Date().toISOString(),
      host: {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.versions.node,
        nodeSupported: process.versions.node.split('.')[0] === '24',
      },
      capabilities: { codexTasks: !!options.desktop, lingxiVoice: false },
    };
  };
  app.get('/api/setup', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return environment();
  });
  let pendingCheck: Promise<CodexCheck> | undefined;
  const inspectCodex = () => {
    pendingCheck ??= (options.checkCodex ?? (() => setup.check()))().finally(() => {
      pendingCheck = undefined;
    });
    return pendingCheck;
  };
  app.post('/api/setup/check', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!z.strictObject({}).safeParse(request.body).success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    // Check both integration boundaries in the same inspection. No Lingxi detector exists yet.
    const lingxi = {
      checkedAt: new Date().toISOString(),
      status: 'unavailable',
      reason: 'adapter-not-connected',
    };
    return { environment: environment(), codex: await inspectCodex(), lingxi };
  });
  app.post('/api/setup/codex/check', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!z.strictObject({}).safeParse(request.body).success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    return inspectCodex();
  });
  app.get('/api/setup/codex/action', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return setup.snapshot();
  });
  app.post('/api/setup/codex/action', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!request.headers.origin) return reply.code(403).send({ error: 'forbidden_origin' });
    const parsed = codexSetupRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = setup.start(parsed.data);
    return reply.code(result.conflict ? 409 : 202).send({ action: result.action });
  });
  app.post('/api/setup/codex/cancel', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!request.headers.origin) return reply.code(403).send({ error: 'forbidden_origin' });
    const parsed = z.strictObject({ id: z.uuid() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!setup.cancel(parsed.data.id)) return reply.code(409).send({ error: 'action_conflict' });
    return setup.snapshot();
  });
  app.post('/api/commands', async (request, reply) => {
    const parsed = submitCommandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const result = store.submit(parsed.data);
      if (!result.replayed) for (const subscriber of subscribers) subscriber(result.snapshot);
      return reply.code(result.replayed ? 200 : 201).send(result.snapshot);
    } catch (error) {
      if (error instanceof StoreConflict) return reply.code(409).send({ error: error.code });
      throw error;
    }
  });
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (snapshot: Session | null) => {
      if (!snapshot) {
        reply.raw.end();
        return;
      }
      reply.raw.write(
        `id: ${snapshot.revision}\nevent: session.snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
      );
    };
    subscribers.add(send);
    // Every connection receives a complete durable snapshot, including on reconnect.
    send(store.read());
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    heartbeat.unref();
    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      subscribers.delete(send);
    });
    request.raw.on('error', () => reply.raw.destroy());
  });

  if (options.webRoot) {
    app.register(fastifyStatic, { root: options.webRoot });
    app.get('/display', (_request, reply) => reply.sendFile('index.html'));
    app.get('/setup', (_request, reply) => reply.sendFile('index.html'));
  }
  app.setErrorHandler((error, request, reply) => {
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply.code(error.statusCode).send({ error: 'invalid_request' });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'internal_error' });
  });
  app.addHook('preClose', async () => {
    await setup.close();
    for (const send of subscribers) send(null);
    subscribers.clear();
  });
  app.addHook('onClose', async () => store.close());
  return Object.assign(app, { workbench });
}
