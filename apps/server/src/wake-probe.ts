import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';

// No model, microphone, network, keyword file or provider session is opened.
try {
  createRequire(import.meta.url)('sherpa-onnx-node');
  parentPort?.postMessage(true);
} catch {
  parentPort?.postMessage(false);
}
