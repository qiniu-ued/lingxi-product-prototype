import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Fixed read-only Git operations; filenames never become shell syntax.
export async function inspectGit(cwd: string) {
  const run = async (args: string[]) =>
    (
      await execute('git', ['--no-pager', ...args], {
        cwd,
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      })
    ).stdout;
  const [status, unstaged, staged] = await Promise.all([
    run(['status', '--short']),
    run(['diff', '--no-ext-diff', '--no-textconv', '--']),
    run(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--']),
  ]);
  return { status, unstaged, staged };
}
