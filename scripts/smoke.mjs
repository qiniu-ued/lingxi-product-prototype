import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.kill('SIGTERM');
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}

async function start(root, databasePath) {
  const launcher = join(root, 'start.sh');
  const packaged = existsSync(launcher);
  const child = spawn(
    packaged ? launcher : process.execPath,
    packaged ? [] : [join(root, 'start-runtime.mjs')],
    {
      cwd: tmpdir(),
      env: { ...process.env, PORT: '0', LINGXI_DB_PATH: databasePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // Source builds use the same compiled entry point as packaged launches.
  let output = '';
  try {
    const address = await new Promise((accept, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Server startup timed out: ${output}`)),
        15000,
      );
      const receive = (chunk) => {
        output = (output + chunk.toString()).slice(-16000);
        const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timeout);
          accept(match[1]);
        }
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited (${code ?? signal}): ${output}`));
      });
    });
    return { child, address };
  } catch (error) {
    await stop(child);
    throw error;
  }
}

export async function smokeProduction(root) {
  const temporary = await mkdtemp(join(tmpdir(), 'lingxi-smoke-'));
  let running;
  const request = async (address, path, options) => {
    const response = await fetch(`${address}${path}`, {
      ...options,
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(response.ok, `${path}: HTTP ${response.status}`);
    return response;
  };
  try {
    const databasePath = join(temporary, 'session.db');
    running = await start(root, databasePath);
    assert.equal((await (await request(running.address, '/api/health')).json()).status, 'ok');
    for (const path of ['/', '/display', '/setup']) {
      const response = await request(running.address, path);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      const html = await response.text();
      const script = html.match(/src="(\/assets\/[^" ]+\.js)"/);
      assert.ok(script, 'Built browser entry point is missing');
      const asset = await request(running.address, script[1]);
      assert.match(asset.headers.get('content-type') ?? '', /javascript/);
    }
    const setup = await (await request(running.address, '/api/setup')).json();
    assert.equal(setup.host.platform, process.platform);
    assert.equal(setup.capabilities.codexTasks, false);
    const initial = await (await request(running.address, '/api/session')).json();
    const command = {
      commandId: randomUUID(),
      source: 'keyboard',
      text: '生产启动与重启恢复检查',
      expectedRevision: initial.revision,
    };
    const saved = await (
      await request(running.address, '/api/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command),
      })
    ).json();
    assert.equal(saved.commands[0].status, 'draft');
    await stop(running.child);
    running = await start(root, databasePath);
    const restored = await (await request(running.address, '/api/session')).json();
    assert.deepEqual(restored, saved, 'Process restart must preserve the complete session');
    assert.equal(restored.commands[0].id, command.commandId);
    assert.deepEqual(restored.integrations, { codex: 'not-configured', lingxi: 'not-configured' });
    console.log('Production smoke passed: pages, assets, API, SQLite and process restart.');
  } finally {
    if (running) await stop(running.child);
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await smokeProduction(resolve(fileURLToPath(new URL('..', import.meta.url))));
}
