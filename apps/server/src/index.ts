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
app.addHook('onClose', async () => {
  if (process.connected) process.disconnect?.();
});
app.addHook('preClose', async () => {
  desktop?.close();
});
process.on('message', (message) => {
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
  if (
    message &&
    typeof message === 'object' &&
    'channel' in message &&
    message.channel === 'desktop.shutdown'
  )
    void app.close();
});
process.once('disconnect', () => {
  void app.close();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4310) });
process.send?.({ channel: 'desktop.ready', port: (app.server.address() as { port: number }).port });
