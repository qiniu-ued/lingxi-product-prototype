import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'lingxi-shutdown-'));
try {
  for (const mode of ['shutdown', 'repeated', 'disconnected', 'startup', 'pending']) {
    const child = spawn(process.execPath, [join(root, 'start-runtime.mjs')], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, PORT: '0', LINGXI_DB_PATH: join(temporary, mode, 'session.db') },
    });
    let stderr = '',
      forced = false,
      requested = false,
      address = '';
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-16000);
    });
    const send = (message) => {
      if (child.connected) child.send(message, () => {});
    };
    child.on('message', (message) => {
      if (message.channel === 'desktop.request') {
        if (mode === 'pending' && requested) {
          if (child.connected) child.disconnect();
        } else send({ channel: 'desktop.reply', id: message.id, result: null });
      }
      if (message.channel !== 'desktop.ready') return;
      address = `http://127.0.0.1:${message.port}`;
      if (mode === 'disconnected') child.disconnect();
      else if (mode === 'pending') {
        requested = true;
        void fetch(`${address}/api/voice/inspect`, {
          method: 'POST',
          headers: { Origin: address, 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      } else {
        for (let i = 0; i < (mode === 'repeated' ? 3 : 1); i++)
          send({ channel: 'desktop.shutdown' });
      }
    });
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const timeout = setTimeout(() => {
      forced = true;
      child.kill('SIGKILL');
    }, 8000);
    if (mode === 'startup') child.disconnect();
    const result = await exit;
    clearTimeout(timeout);
    assert.equal(forced, false, `${mode}: service did not release its resources: ${stderr}`);
    assert.deepEqual(result, { code: 0, signal: null }, `${mode}: ${stderr}`);
    assert.doesNotMatch(stderr, /ERR_IPC_CHANNEL_CLOSED|Unhandled|uncaught|shutdown failed/i);
    assert.throws(
      () => process.kill(child.pid, 0),
      { code: 'ESRCH' },
      `${mode}: child remains alive`,
    );
    if (address)
      await assert.rejects(fetch(`${address}/api/health`, { signal: AbortSignal.timeout(1000) }));
    console.log(`Shutdown verified: ${mode}, clean exit and no remaining service.`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
