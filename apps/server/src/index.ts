import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const databasePath = process.env.LINGXI_DB_PATH
  ? resolve(process.env.LINGXI_DB_PATH)
  : fileURLToPath(new URL('../../../.local/lingxi.db', import.meta.url));
mkdirSync(dirname(databasePath), { recursive: true });
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const app = buildApp({
  databasePath,
  logger: true,
  ...(existsSync(webRoot) ? { webRoot } : {}),
  ...(process.env.LINGXI_WEB_ORIGIN ? { webOrigin: process.env.LINGXI_WEB_ORIGIN } : {}),
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4310) });
