import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
let commit = null,
  dirty = false;
if (existsSync(new URL('../.git', import.meta.url))) {
  try {
    const value = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[a-f0-9]{40}$/.test(value)) commit = value;
    dirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    commit = null;
  }
}
await writeFile(
  new URL('../apps/server/dist/build-info.json', import.meta.url),
  JSON.stringify({ version, commit, dirty, builtAt: new Date().toISOString() }),
);
