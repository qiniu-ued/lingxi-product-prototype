import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

type Stream = { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void };
type Spotter = {
  createStream(): Stream;
  isReady(stream: Stream): boolean;
  decode(stream: Stream): void;
  getResult(stream: Stream): { keyword: string };
  reset(stream: Stream): void;
};
const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node') as { KeywordSpotter: new (config: unknown) => Spotter };
const { root, files, line } = workerData as { root: string; files: string[]; line: string };
const keywordsFile = join(root, 'active-keyword.txt');
writeFileSync(keywordsFile, `${line}\n`, { mode: 0o600 });
const spotter = new sherpa.KeywordSpotter({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: join(root, files[0] as string),
      decoder: join(root, files[1] as string),
      joiner: join(root, files[2] as string),
    },
    tokens: join(root, 'tokens.txt'),
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  },
  keywordsFile,
  keywordsThreshold: 0.25,
  keywordsScore: 1.5,
});
let stream = spotter.createStream();
let triggered = false;
parentPort?.on('message', (message: Uint8Array | string) => {
  if (message === 'reset') {
    stream = spotter.createStream();
    triggered = false;
    return;
  }
  if (typeof message !== 'string' && message.byteLength === 640 && !triggered) {
    const data = new DataView(message.buffer, message.byteOffset, message.byteLength);
    const samples = Float32Array.from(
      { length: 320 },
      (_, i) => data.getInt16(i * 2, true) / 32768,
    );
    stream.acceptWaveform({ sampleRate: 16000, samples });
    while (spotter.isReady(stream)) {
      spotter.decode(stream);
      if (spotter.getResult(stream).keyword) {
        triggered = true;
        parentPort?.postMessage('detected');
        break;
      }
    }
  }
  parentPort?.postMessage('frame');
});
parentPort?.postMessage('ready');
