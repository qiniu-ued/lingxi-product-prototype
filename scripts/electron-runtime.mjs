import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
export function electronBinary() {
  const directory = dirname(require.resolve('electron/package.json'));
  if (!existsSync(join(directory, 'path.txt'))) {
    const installed = spawnSync(process.execPath, [join(directory, 'install.js')], {
      stdio: 'inherit',
      env: process.env,
    });
    if (installed.status !== 0) throw new Error('Electron download failed');
  }
  return require('electron');
}
