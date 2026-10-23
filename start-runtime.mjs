import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error('灵矽需要 Node.js 24.x，请安装该版本后重试。');
}
const manifestUrl = new URL('./runtime-manifest.json', import.meta.url);
if (existsSync(manifestUrl)) {
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error(`运行包需要 ${manifest.platform}/${manifest.arch}，请下载适合当前电脑的版本。`);
  }
}
if (!process.env.LINGXI_DB_PATH) {
  const dataRoot =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Lingxi')
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'lingxi');
  process.env.LINGXI_DB_PATH = join(dataRoot, 'lingxi.db');
}
await import('./apps/server/dist/index.js');
