import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { inspectGit } from './workspace-git.js';

const execute = promisify(execFile);
it('separates staged, unstaged and untracked files without running external diff commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingxi-git-'));
  const git = (args: string[]) => execute('git', args, { cwd: root });
  try {
    await expect(inspectGit(root)).rejects.toThrow();
    await git(['init']);
    await git(['config', 'user.email', 'test@example.invalid']);
    await git(['config', 'user.name', 'Test']);
    await writeFile(join(root, 'file.txt'), 'first\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'initial']);
    await writeFile(join(root, 'file.txt'), 'staged\n');
    await git(['add', '.']);
    await writeFile(join(root, 'file.txt'), 'working\n');
    await writeFile(join(root, 'new.txt'), 'PRIVATE_UNTRACKED_CONTENT');
    const state = await inspectGit(root);
    expect(state.staged).toContain('+staged');
    expect(state.unstaged).toContain('+working');
    expect(state.status).toContain('?? new.txt');
    expect(JSON.stringify(state)).not.toContain('PRIVATE_UNTRACKED_CONTENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
