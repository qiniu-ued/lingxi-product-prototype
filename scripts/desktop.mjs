import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronBinary } from './electron-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const child = spawn(electronBinary(), [resolve(root, 'apps/desktop'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    LINGXI_NODE_BIN: process.execPath,
    ...(process.env.npm_execpath
      ? { LINGXI_NPM_CLI: resolve(dirname(process.env.npm_execpath), 'npm-cli.js') }
      : {}),
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
