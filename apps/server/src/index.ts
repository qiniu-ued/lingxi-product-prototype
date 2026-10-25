import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { IpcDesktopBridge } from './desktop-bridge.js';

const databasePath = process.env.LINGXI_DB_PATH
  ? resolve(process.env.LINGXI_DB_PATH)
  : fileURLToPath(new URL('../../../.local/lingxi.db', import.meta.url));
mkdirSync(dirname(databasePath), { recursive: true });
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const desktop = process.send ? new IpcDesktopBridge() : undefined;
const app = buildApp({
  databasePath,
  logger: !desktop,
  ...(desktop ? { desktop, mcpToken: process.env.LINGXI_PREVIEW_MCP_TOKEN ?? '' } : {}),
  ...(existsSync(webRoot) ? { webRoot } : {}),
  ...(process.env.LINGXI_WEB_ORIGIN ? { webOrigin: process.env.LINGXI_WEB_ORIGIN } : {}),
});
let stopping = false;
let stopPromise: Promise<void> | undefined;
let listening: Promise<string> | undefined;
app.addHook('onRequest', async (_request, reply) => {
  if (stopping) return reply.code(503).send({ error: 'service_stopping' });
});
function shutdown() {
  if (stopPromise) return stopPromise;
  stopping = true;
  // Close the bridge first: voice/worker cleanup must not create new IPC requests.
  desktop?.close();
  let voiceError: unknown;
  const voiceClosed = app.voice.close().catch((error: unknown) => {
    voiceError = error;
  });
  stopPromise = (async () => {
    await listening?.catch(() => {});
    await app.close();
    await voiceClosed;
    if (process.connected) process.disconnect?.();
    if (voiceError) throw voiceError;
  })().catch((error: unknown) => {
    console.error('Local service shutdown failed:', (error as Error).name);
    process.exitCode = 1;
    if (process.connected) process.disconnect?.();
  });
  return stopPromise;
}
app.addHook('preClose', async () => desktop?.close());
process.on('message', (message) => {
  if (stopping) return;
  if (
    message &&
    typeof message === 'object' &&
    'channel' in message &&
    message.channel === 'desktop.voice-stop'
  )
    app.voice.disconnect({ source: 'system', reason: 'system_suspend', explicitClose: false });
  if (
    message &&
    typeof message === 'object' &&
    'channel' in message &&
    message.channel === 'desktop.voice-resume'
  )
    void app.voice.startAutoConnection(true);
  if (
    message &&
    typeof message === 'object' &&
    'channel' in message &&
    message.channel === 'desktop.audio' &&
    'pcm' in message &&
    typeof message.pcm === 'string'
  )
    app.voice.frame(message.pcm);
  if (
    message &&
    typeof message === 'object' &&
    'channel' in message &&
    message.channel === 'desktop.preview' &&
    'preview' in message
  ) {
    try {
      app.workbench.setPreview(message.preview);
    } catch {
      /* A previous project's window may be closing. */
    }
  }
});
process.on('message', (message) => {
  if (stopping) return;
  if (
    message &&
    typeof message === 'object' &&
    'channel' in message &&
    message.channel === 'desktop.shutdown'
  )
    void shutdown();
});
process.once('disconnect', () => {
  void shutdown();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown();
  });
}
listening = app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4310) });
if (desktop && !process.connected) void shutdown();
try {
  await listening;
  if (!stopping) {
    if (desktop) void app.voice.startAutoConnection();
    if (process.connected && process.send) {
      const readyFailed = (error: Error | null) => {
        if (!error) return;
        const closed = ['ERR_IPC_CHANNEL_CLOSED', 'ERR_IPC_DISCONNECTED', 'EPIPE'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        );
        if (!stopping && !closed) {
          console.error('Local service ready notification failed:', error.name);
          process.exitCode = 1;
        }
        void shutdown();
      };
      try {
        process.send(
          { channel: 'desktop.ready', port: (app.server.address() as { port: number }).port },
          readyFailed,
        );
      } catch (error) {
        readyFailed(error as Error);
      }
    }
  }
} catch (error) {
  if (!stopping) {
    console.error('Local service startup failed:', (error as Error).name);
    process.exitCode = 1;
  }
  await shutdown();
}
