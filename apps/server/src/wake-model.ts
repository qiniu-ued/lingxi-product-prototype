import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { type WakeCheck, wakeKeywordSchema } from '@lingxi/protocol';
import { pinyin } from 'pinyin-pro';

const run = promisify(execFile);
export const modelName = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20';
export const modelDigest = '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6';
const suffix = 'epoch-13-avg-2-chunk-16-left-64';
export const modelFiles = [
  `encoder-${suffix}.int8.onnx`,
  `decoder-${suffix}.onnx`,
  `joiner-${suffix}.int8.onnx`,
  'tokens.txt',
];
const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${modelName}.tar.bz2`;

export function keywordTokens(keyword: string, vocabulary: string) {
  wakeKeywordSchema.parse(keyword);
  const initials = pinyin(keyword, { type: 'array', pattern: 'initial' });
  const finals = pinyin(keyword, { type: 'array', pattern: 'final' });
  const tokens = initials.flatMap((initial, i) => {
    let final = finals[i] ?? '';
    // The upstream ppinyin tokenizer uses strict=False: jqxy omit the umlaut.
    if (['j', 'q', 'x', 'y'].includes(initial))
      final = final
        .normalize('NFD')
        .replace(/\u0308/g, '')
        .normalize('NFC');
    return [initial, final].filter(Boolean);
  });
  const allowed = new Set(vocabulary.split('\n').map((line) => line.split(' ')[0]));
  if (tokens.some((token) => !allowed.has(token))) throw new Error('unsupported_keyword');
  return `${tokens.join(' ')} @${keyword}`;
}

// The model is a fixed upstream release, authenticated before any extraction.
// No user URL, archive member, executable or argv is accepted by this adapter.
export class WakeModel {
  private closed = false;
  private generation = 0;
  private closing: Promise<void> | undefined;
  private terminating = new Set<Promise<number>>();
  private terminate(worker: Worker) {
    const pending = worker.terminate();
    this.terminating.add(pending);
    void pending.then(
      () => this.terminating.delete(pending),
      () => this.terminating.delete(pending),
    );
  }
  private abort: AbortController | undefined;
  private worker: Worker | undefined;
  private pending = 0;
  private probes = new Set<Worker>();
  private inspection: Promise<boolean> | undefined;
  constructor(
    readonly root: string,
    private testProbe?: () => Promise<boolean>,
  ) {}
  private probe() {
    if (this.closed) return Promise.resolve(false);
    this.inspection ??= new Promise<boolean>((resolve) => {
      const worker = new Worker(new URL('./wake-probe.js', import.meta.url));
      this.probes.add(worker);
      const finish = (ready: boolean) => {
        clearTimeout(timer);
        this.probes.delete(worker);
        this.terminate(worker);
        resolve(ready);
      };
      const timer = setTimeout(() => finish(false), 8000);
      worker.once('message', (value) => finish(value === true));
      worker.once('error', () => finish(false));
      worker.once('exit', () => finish(false));
    }).finally(() => {
      this.inspection = undefined;
    });
    return this.inspection;
  }
  async check(): Promise<WakeCheck> {
    const checkedAt = new Date().toISOString();
    if (!(await this.installed()))
      return { checkedAt, status: 'not-installed', reason: 'model-missing' };
    try {
      if (await (this.testProbe?.() ?? this.probe()))
        return { checkedAt, status: 'ready', reason: 'model-ready' };
    } catch {
      /* Keep native paths and errors private. */
    }
    return { checkedAt, status: 'unavailable', reason: 'native-unavailable' };
  }
  async installed() {
    try {
      return (
        (await readFile(join(this.root, 'installed'), 'utf8')) === modelDigest &&
        (
          await Promise.all(modelFiles.map((file) => readFile(join(this.root, modelName, file))))
        ).every((data) => data.length > 0)
      );
    } catch {
      return false;
    }
  }
  async install() {
    if (this.closed) throw new Error('wake_model_closed');
    if (this.abort) throw new Error('wake_install_busy');
    const installed = await this.installed();
    if (this.closed) throw new Error('wake_model_closed');
    if (installed) return;
    const abort = new AbortController();
    this.abort = abort;
    const timeout = setTimeout(() => abort.abort(), 180_000);
    let stage: string | undefined;
    try {
      await mkdir(this.root, { recursive: true });
      stage = await mkdtemp(join(this.root, 'download-'));
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok || !response.body) throw new Error('wake_download_failed');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 34 * 1024 * 1024) {
          abort.abort();
          throw new Error('wake_model_too_large');
        }
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      if (createHash('sha256').update(data).digest('hex') !== modelDigest)
        throw new Error('wake_checksum_failed');
      const archive = join(stage, 'model.tar.bz2');
      await writeFile(archive, data, { mode: 0o600 });
      await run(
        'tar',
        ['-xjf', archive, '-C', stage, ...modelFiles.map((file) => `${modelName}/${file}`)],
        { signal: abort.signal, timeout: 30000 },
      );
      await rm(join(this.root, modelName), { recursive: true, force: true });
      await rename(join(stage, modelName), join(this.root, modelName));
      await writeFile(join(this.root, 'installed'), modelDigest, { mode: 0o600 });
    } finally {
      clearTimeout(timeout);
      this.abort = undefined;
      if (stage) await rm(stage, { recursive: true, force: true });
    }
  }
  async start(keyword: string, detected: () => void, failed: () => void) {
    if (this.closed) throw new Error('wake_model_closed');
    const generation = ++this.generation;
    const installed = await this.installed();
    if (this.closed || generation !== this.generation) throw new Error('wake_cancelled');
    if (!installed) throw new Error('wake_model_missing');
    const line = keywordTokens(
      keyword,
      await readFile(join(this.root, modelName, 'tokens.txt'), 'utf8'),
    );
    if (this.closed || generation !== this.generation) throw new Error('wake_cancelled');
    this.stop();
    const worker = new Worker(new URL('./wake-worker.js', import.meta.url), {
      workerData: { root: join(this.root, modelName), line, files: modelFiles },
    });
    this.worker = worker;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop();
        reject(new Error('wake_start_timeout'));
      }, 15000);
      let ready = false;
      worker.on('message', (message) => {
        if (worker !== this.worker) return;
        if (message === 'ready') {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
        if (message === 'frame') this.pending = Math.max(0, this.pending - 1);
        if (message === 'detected') detected();
      });
      const fail = () => {
        clearTimeout(timer);
        if (!ready) reject(new Error('wake_worker_failed'));
        if (worker === this.worker) {
          this.stop();
          if (ready) failed();
        }
      };
      worker.on('error', fail);
      worker.on('exit', fail);
    });
  }
  frame(pcm: Buffer) {
    if (!this.worker || this.pending >= 25) return;
    this.pending++;
    this.worker.postMessage(pcm);
  }
  reset() {
    this.worker?.postMessage('reset');
  }
  stop() {
    this.generation++;
    const worker = this.worker;
    this.worker = undefined;
    this.pending = 0;
    if (worker) this.terminate(worker);
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort?.abort();
    for (const probe of this.probes) this.terminate(probe);
    this.stop();
    this.closing = Promise.all([...this.terminating]).then(() => {});
    return this.closing;
  }
}
