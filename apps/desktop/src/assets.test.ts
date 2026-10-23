import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { freezePreview } from './assets.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function create() {
  const root = await mkdtemp(join(tmpdir(), 'lingxi-assets-'));
  temporary.push(root);
  const project = { id: randomUUID(), name: 'Test', path: join(root, 'project') };
  await mkdir(join(project.path, 'preview'), { recursive: true });
  await writeFile(join(project.path, 'preview/index.html'), '<h1>Test</h1>');
  return { root, project };
}
it('canonicalizes data directory aliases before serving frozen public assets', async () => {
  const { root, project } = await create();
  const data = join(root, 'actual-data'),
    alias = join(root, 'alias-data');
  await mkdir(data);
  await symlink(data, alias, 'dir');
  await writeFile(join(project.path, 'preview/.env'), 'not-public');
  await writeFile(join(project.path, 'preview/source.ts'), 'not-public');
  const first = await freezePreview(project, alias);
  expect(first.root).toBe(await realpath(first.root));
  expect(first.root.startsWith(await realpath(data))).toBe(true);
  expect(await readdir(first.root)).toEqual(['index.html']);
  expect(await readFile(join(first.root, 'index.html'), 'utf8')).toBe('<h1>Test</h1>');
  const next = await freezePreview(project, data);
  expect(next.digest).toBe(first.digest);
  await writeFile(join(project.path, 'preview/index.html'), '<h1>Changed</h1>');
  expect((await freezePreview(project, data)).digest).not.toBe(first.digest);
});
it('rejects public-directory escapes and symlink assets without exposing project files', async () => {
  const { root, project } = await create();
  const preview = join(project.path, 'preview');
  await symlink(join(root, 'private.json'), join(preview, 'secret.json'));
  await expect(freezePreview(project, join(root, 'data'))).rejects.toThrow('symlink_in_preview');
  await rm(preview, { recursive: true });
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), preview, 'dir');
  await expect(freezePreview(project, join(root, 'data'))).rejects.toThrow(
    'preview_outside_project',
  );
});
it('requires an entry point and bounds the asset count', async () => {
  const { root, project } = await create();
  await rm(join(project.path, 'preview/index.html'));
  await expect(freezePreview(project, join(root, 'data'))).rejects.toThrow();
  await Promise.all(
    Array.from({ length: 501 }, (_, i) =>
      writeFile(join(project.path, 'preview', `${i}.json`), '{}'),
    ),
  );
  await expect(freezePreview(project, join(root, 'data'))).rejects.toThrow('preview_too_large');
});
