import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Project } from '@lingxi/protocol';

export const types: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};
export const inside = (root: string, path: string) => {
  const r = relative(root, path);
  return !r.startsWith('..') && !isAbsolute(r);
};

// Capture only public frontend assets, never the project root, credentials or node_modules.
export async function freezePreview(project: Project, dataRoot: string) {
  const source = await realpath(join(project.path, 'preview'));
  if (!inside(await realpath(project.path), source)) throw new Error('preview_outside_project');
  const output = join(dataRoot, 'artifacts', project.id, randomUUID());
  const digest = createHash('sha256');
  let bytes = 0;
  const files: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('symlink_in_preview');
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() || !types[extname(entry.name).toLowerCase()]) continue;
      files.push(path);
      if (files.length > 500) throw new Error('preview_too_large');
    }
  };
  await visit(source);
  if (!files.includes(join(source, 'index.html'))) throw new Error('preview_entry_missing');
  // Reject over-limit input before creating hundreds of copies on slower disks.
  const actualFiles: string[] = [];
  for (const file of files) {
    const actual = await realpath(file);
    if (!inside(source, actual)) throw new Error('asset_outside_preview');
    bytes += (await stat(actual)).size;
    if (bytes > 30_000_000) throw new Error('preview_too_large');
    actualFiles.push(actual);
  }
  bytes = 0;
  for (const actual of actualFiles) {
    const content = await readFile(actual);
    bytes += content.length;
    if (bytes > 30_000_000) throw new Error('preview_too_large');
    const name = relative(source, actual),
      target = join(output, name);
    digest.update(name);
    digest.update(content);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
  await stat(join(output, 'index.html'));
  return { root: await realpath(output), digest: digest.digest('hex') };
}
