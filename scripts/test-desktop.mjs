import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';
import { WorkbenchStore } from '../apps/server/dist/workbench-store.js';
import { electronBinary } from './electron-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'lingxi-desktop-smoke-'));
const dataRoot = join(temporary, 'data'),
  projectPath = join(temporary, 'project');
await mkdir(dataRoot);
await mkdir(join(projectPath, 'preview'), { recursive: true });
await writeFile(
  join(projectPath, 'preview/index.html'),
  `<!doctype html><html lang="zh"><meta charset="utf-8"><title>周末，一起去哪里？</title><style>body{font:24px system-ui;padding:40px;background:#f6eadb;color:#453d33}button,input{font:inherit;padding:15px;margin-top:20px}h1{font-size:40px}</style><h1>周末，一起去哪里？</h1><button id="vote">金山城市沙滩</button><p>票数：<strong id="count"></strong></p><input aria-label="备注"><script>const count=document.querySelector('#count');count.textContent=localStorage.votes||'0';document.querySelector('#vote').onclick=()=>{localStorage.votes=String(Number(localStorage.votes||0)+1);count.textContent=localStorage.votes}</script></html>`,
);
const store = new WorkbenchStore(join(dataRoot, 'lingxi.db'));
const state = store.read();
state.project = { id: randomUUID(), name: '周末出游', path: projectPath };
store.write(state);
store.close();
const fixture = join(temporary, 'codex');
await cp(join(root, 'tests/fixtures/codex-task.mjs'), fixture);
await chmod(fixture, 0o755);
const record = join(temporary, 'peer.jsonl');
let instance, liveServer;
const launch = () =>
  _electron.launch({
    executablePath: process.env.LINGXI_DESKTOP_BUNDLE
      ? join(process.env.LINGXI_DESKTOP_BUNDLE, 'Contents/MacOS/Lingxi')
      : electronBinary(),
    args: [
      ...(process.env.LINGXI_DESKTOP_BUNDLE ? [] : [join(root, 'apps/desktop')]),
      ...(process.platform === 'linux'
        ? ['--no-sandbox', '--ozone-platform=headless', '--headless', '--disable-gpu']
        : []),
    ],
    env: {
      ...process.env,
      LINGXI_NODE_BIN: process.execPath,
      LINGXI_DESKTOP_DATA: dataRoot,
      LINGXI_CODEX_BIN: fixture,
      LINGXI_TASK_FIXTURE_MODE: 'browser',
      LINGXI_TASK_FIXTURE_RECORD: record,
      XDG_CACHE_HOME: join(temporary, 'cache'),
    },
    timeout: 25000,
  });
try {
  instance = await launch();
  const operator = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.setContentSize(1440, 940);
  });
  await operator.getByText('本机服务已连接').waitFor();
  const address = new URL(operator.url()).origin;
  await operator.getByLabel('模型', { exact: true }).selectOption('test-model');
  await operator.getByLabel('Reasoning Effort', { exact: true }).selectOption('high');
  const beforeTasks = await readFile(record, 'utf8');
  assert.ok(!beforeTasks.includes('thread/start'), 'Loading model choices must not start a thread');

  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await (await fetch(`${address}/api/workbench`)).json();
    if (current.preview) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const before = await (await fetch(`${address}/api/workbench`)).json();
  assert.ok(before.preview);
  const previews = await instance.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((w) => w.getURL().startsWith('lingxi-preview:'))
      .map((w) => ({ id: w.id, url: w.getURL() })),
  );
  assert.equal(previews.length, 1);
  assert.equal(previews[0].url, before.preview.url);
  const isolation = await instance.evaluate(async ({ webContents }) => {
    const page = webContents
      .getAllWebContents()
      .find((w) => w.getURL().startsWith('lingxi-preview:'));
    return page.executeJavaScript(`({desktop:typeof window.lingxiDesktop,node:typeof process})`);
  });
  assert.deepEqual(isolation, { desktop: 'undefined', node: 'undefined' });
  await operator.getByRole('button', { name: '点选修改', exact: true }).click();
  await operator
    .getByRole('img', { name: '大屏中同一个作品页面的实时画面' })
    .click({ position: { x: 150, y: 65 } });
  await operator.getByRole('button', { name: '清除选择' }).waitFor();
  await operator.getByLabel('给 Codex 的本轮指令').fill('vote and type');
  await operator.getByRole('button', { name: '提交给 Codex' }).click();
  let after;
  for (let attempt = 0; attempt < 150; attempt++) {
    after = await (await fetch(`${address}/api/workbench`)).json();
    if (after.task && ['completed', 'failed'].includes(after.task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(after.task.status, 'completed', JSON.stringify(after.task));
  assert.equal(after.task.settings.model, 'test-model');
  assert.equal(after.task.settings.effort, 'high');
  await operator.getByRole('meter', { name: '上下文窗口占用', exact: true }).waitFor();
  assert.equal(
    await operator
      .getByRole('meter', { name: '上下文窗口占用', exact: true })
      .getAttribute('aria-valuetext'),
    '25.0% 已使用',
  );
  await operator.getByLabel('模型', { exact: true }).selectOption('fast-model');
  await operator.waitForFunction(() => document.querySelector('#codex-effort').value === 'low');
  assert.equal(await operator.locator('#codex-effort option[value="high"]').count(), 0);

  assert.ok(after.task.selection, 'Pointer selection must reach the same Codex task');
  assert.equal(
    after.preview.revision,
    before.preview.revision,
    'Browser-only tasks must not reload the page',
  );
  const inspect = () =>
    instance.evaluate(async ({ webContents }) => {
      const page = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith('lingxi-preview:'));
      return page.executeJavaScript(
        `({count:document.querySelector('#count').textContent,note:document.querySelector('input').value})`,
      );
    });
  assert.deepEqual(await inspect(), { count: '1', note: '周末出发' });
  const screenshot = join(root, '.local', 'desktop-smoke.png');
  await mkdir(join(root, '.local'), { recursive: true });
  await operator.screenshot({ path: screenshot });
  // Publish a new revision and prove localStorage continuity across a real document reload.
  const file = join(projectPath, 'preview/index.html');
  await writeFile(file, (await readFile(file, 'utf8')).replace('周末，一起去哪里？', '周末出发'));
  await operator.getByRole('button', { name: '刷新作品' }).click();
  for (let i = 0; i < 100; i++) {
    const current = await (await fetch(`${address}/api/workbench`)).json();
    if (current.preview?.revision > before.preview.revision) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal((await inspect()).count, '1');
  await operator.getByLabel('给 Codex 的本轮指令').fill('stale binding check');
  await operator.getByRole('button', { name: '提交给 Codex' }).click();
  for (let i = 0; i < 100; i++) {
    const value = await (await fetch(`${address}/api/workbench`)).json();
    if (
      value.task?.prompt === 'stale binding check' &&
      ['completed', 'failed'].includes(value.task.status)
    ) {
      assert.equal(value.task.status, 'completed');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await inspect()).count, '1', 'Stale MCP action must not affect the new page');
  const records = (await readFile(record, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const item of records.filter((r) => r.pid))
    assert.doesNotThrow(() => process.kill(item.pid, 0));
  await instance.close();
  instance = undefined;
  for (const item of records.filter((r) => r.pid)) assert.throws(() => process.kill(item.pid, 0));
  await assert.rejects(
    fetch(`${address}/api/health`),
    'Owned local service must stop with desktop app',
  );
  instance = await launch();
  const reopened = await instance.firstWindow();
  await reopened.getByText('本机服务已连接').waitFor();
  await instance.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.setContentSize(1440, 940);
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await inspect()).count === '1') break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await inspect()).count, '1');
  // Exercise the new workspace in the actual renderer, not only API fixtures.
  const reopenedAddress = new URL(reopened.url()).origin;
  await reopened.getByRole('button', { name: '终端', exact: true }).click();
  await reopened.getByRole('button', { name: '打开终端', exact: true }).click();
  await reopened.getByText('项目终端 · running', { exact: false }).waitFor();
  await reopened.locator('.xterm-helper-textarea').pressSequentially('pwd');
  await reopened.locator('.xterm-helper-textarea').press('Enter');
  await reopened.getByRole('button', { name: '结束终端', exact: true }).click();
  await reopened.getByText('项目终端 · exited', { exact: false }).waitFor();
  await reopened.getByRole('button', { name: 'Diff', exact: true }).click();
  await reopened.locator('.diff-lines button').filter({ hasText: '+new' }).click();
  await reopened.getByLabel('Diff 评论').fill('请调整这一行');
  await reopened
    .locator('.workspace-tool')
    .getByRole('button', { name: '添加到对话', exact: true })
    .click();
  await reopened.locator('.context-attachments').getByText('Codex 本轮变更').waitFor();
  await reopened.locator('.context-attachments').getByRole('button', { name: '移除' }).click();
  await reopened.getByRole('button', { name: '预览', exact: true }).click();
  const audioFrame = await reopened.evaluate(async () => {
    const context = new OfflineAudioContext(1, 960, 16000);
    await context.audioWorklet.addModule('/pcm-worklet.js');
    const node = new AudioWorkletNode(context, 'lingxi-pcm-capture');
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 1000;
    oscillator.connect(node);
    node.connect(context.destination);
    oscillator.start();
    const firstFrame = new Promise((resolve) => {
      node.port.onmessage = (event) => resolve(event.data);
    });
    const [frame] = await Promise.all([firstFrame, context.startRendering()]);
    const values = new Int16Array(frame);
    const result = { bytes: frame.byteLength, max: Math.max(...values) };
    return result;
  });
  assert.equal(audioFrame.bytes, 640);
  assert.ok(audioFrame.max > 1000);
  liveServer = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/api') {
      response.end('same origin works');
      return;
    }
    response.end(
      `<!doctype html><html><body><h1>Live project</h1><button id="vote">金山城市沙滩</button><p>票数 <strong id="count">0</strong></p><script>let votes=0;document.querySelector('#vote').onclick=()=>document.querySelector('#count').textContent=String(++votes);fetch('/api').then(r=>r.text()).then(t=>document.body.dataset.api=t);fetch(${JSON.stringify(`${reopenedAddress}/api/health`)}).then(()=>document.body.dataset.blocked='no').catch(()=>document.body.dataset.blocked='yes')</script></body></html>`,
    );
  });
  await new Promise((resolve) => liveServer.listen(0, '127.0.0.1', resolve));
  const liveUrl = `http://127.0.0.1:${liveServer.address().port}/`;
  const connectLive = (url) =>
    fetch(`${reopenedAddress}/api/workbench/preview-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: reopenedAddress },
      body: JSON.stringify({ url }),
    });
  assert.equal((await connectLive(`${reopenedAddress}/`)).status, 409);
  assert.equal((await connectLive('https://example.com/')).status, 409);
  await reopened.getByText('连接项目开发服务器', { exact: true }).click();
  await reopened.getByLabel('项目预览地址').fill(liveUrl);
  await reopened.getByRole('button', { name: '连接预览', exact: true }).click();
  const inspectLive = () =>
    instance.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find((w) => w.getURL() === url);
      return page.executeJavaScript(
        `({count:document.querySelector('#count').textContent,api:document.body.dataset.api,blocked:document.body.dataset.blocked,desktop:typeof window.lingxiDesktop,node:typeof process})`,
      );
    }, liveUrl);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await inspectLive()).blocked === 'yes') break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.deepEqual(await inspectLive(), {
    count: '0',
    api: 'same origin works',
    blocked: 'yes',
    desktop: 'undefined',
    node: 'undefined',
  });
  await reopened.getByLabel('给 Codex 的本轮指令').fill('vote in live project');
  await reopened.getByRole('button', { name: '提交给 Codex', exact: true }).click();
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await (await fetch(`${reopenedAddress}/api/workbench`)).json();
    if (value.task?.prompt === 'vote in live project' && value.task.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const liveState = await (await fetch(`${reopenedAddress}/api/workbench`)).json();
  assert.equal(
    liveState.task?.status,
    'completed',
    JSON.stringify({
      task: liveState.task,
      peer: (await readFile(record, 'utf8')).trim().split('\n').slice(-10),
    }),
  );
  assert.equal(
    (await inspectLive()).count,
    '1',
    `MCP must act on the exact live project page: ${JSON.stringify(liveState.task)}`,
  );
  const layout = await reopened.evaluate(() => ({
    preview: document.querySelector('.live-viewport').getBoundingClientRect().bottom,
    footer: document.querySelector('.live-footer').getBoundingClientRect().top,
  }));
  await reopened.screenshot({ path: join(root, '.local/workspace-smoke.png') });
  assert.ok(
    layout.preview <= layout.footer,
    `Preview must stay inside its panel: ${JSON.stringify(layout)}`,
  );
  await reopened.goto(`${reopenedAddress}/setup`);
  await reopened
    .getByRole('button', { name: /配置灵矽/ })
    .first()
    .click();
  await reopened.getByRole('button', { name: '获取本机绑定码', exact: true }).waitFor();
  await reopened.screenshot({ path: join(root, '.local/voice-setup-smoke.png') });
  console.log(
    `Desktop verified: canonical static/live preview, MCP retry, terminal, diff context, PCM worklet, device wizard, shutdown and restart. Screenshot: ${screenshot}`,
  );
} finally {
  if (instance) await instance.close();
  if (liveServer) await new Promise((resolve) => liveServer.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
