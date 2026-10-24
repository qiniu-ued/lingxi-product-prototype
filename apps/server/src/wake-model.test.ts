import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { keywordTokens, modelDigest, modelFiles, modelName, WakeModel } from './wake-model.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'lingxi-wake-model-'));
  roots.push(root);
  return new WakeModel(root);
}
it('converts Chinese wake phrases to validated model phonemes and rejects unsupported input', () => {
  const vocabulary = ['l', 'ì', 't', 'ǎ', 'óng', 'x', 'ué']
    .map((token, i) => `${token} ${i}`)
    .join('\n');
  expect(keywordTokens('丽塔同学', vocabulary)).toBe('l ì t ǎ t óng x ué @丽塔同学');
  expect(() => keywordTokens('丽塔同学', 'l 0')).toThrow('unsupported_keyword');
  for (const bad of ['丽', 'Rita', '丽塔\n同学', '丽塔@同学', '同学'.repeat(7)])
    expect(() => keywordTokens(bad, vocabulary)).toThrow();
});
it('requires the pinned model marker and all assets, and reuses an installed model offline', async () => {
  const model = await setup();
  expect(await model.installed()).toBe(false);
  expect((await model.check()).reason).toBe('model-missing');
  await mkdir(join(model.root, modelName));
  await writeFile(join(model.root, 'installed'), modelDigest);
  expect(await model.installed()).toBe(false);
  for (const file of modelFiles) await writeFile(join(model.root, modelName, file), 'test');
  expect(await model.installed()).toBe(true);
  expect(await new WakeModel(model.root, async () => true).check()).toMatchObject({
    status: 'ready',
    reason: 'model-ready',
  });
  expect(await new WakeModel(model.root, async () => false).check()).toMatchObject({
    status: 'unavailable',
    reason: 'native-unavailable',
  });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await model.install();
  expect(fetcher).not.toHaveBeenCalled();
  await expect(
    model.start(
      '丽塔同学',
      () => {},
      () => {},
    ),
  ).rejects.toThrow('unsupported_keyword');
  model.reset();
  model.frame(Buffer.alloc(640));
  model.close();
});
it('fails closed on HTTP, checksum and size errors without installing downloaded bytes', async () => {
  const model = await setup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 403 })),
  );
  await expect(model.install()).rejects.toThrow('wake_download_failed');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('untrusted model')),
  );
  await expect(model.install()).rejects.toThrow('wake_checksum_failed');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array(35 * 1024 * 1024))),
  );
  await expect(model.install()).rejects.toThrow('wake_model_too_large');
  expect(await model.installed()).toBe(false);
  await expect(readFile(join(model.root, 'installed'))).rejects.toThrow();
  await expect(
    model.start(
      '丽塔同学',
      () => {},
      () => {},
    ),
  ).rejects.toThrow('wake_model_missing');
});
it('aborts an in-progress model download on shutdown and allows a later retry', async () => {
  const model = await setup();
  const fetcher = vi.fn(
    (_url: string, { signal }: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled'))),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const installing = model.install();
  const rejected = expect(installing).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
  await expect(model.install()).rejects.toThrow('wake_install_busy');
  model.close();
  await rejected;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 503 })),
  );
  await expect(model.install()).rejects.toThrow('wake_download_failed');
});
