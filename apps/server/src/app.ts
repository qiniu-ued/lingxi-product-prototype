import { isIP } from 'node:net';
import fastifyStatic from '@fastify/static';
import { type Session, submitCommandSchema } from '@lingxi/protocol';
import Fastify from 'fastify';
import { SessionStore, StoreConflict } from './store.js';

interface AppOptions {
  databasePath: string;
  webRoot?: string;
  webOrigin?: string;
  logger?: boolean;
}

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16 * 1024 });
  const store = new SessionStore(options.databasePath);
  const subscribers = new Set<(snapshot: Session | null) => void>();

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
    for (const send of subscribers) send(null);
    subscribers.clear();
  });
  app.addHook('onClose', async () => store.close());
  return app;
}
