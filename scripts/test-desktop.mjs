import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
let instance;
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
  for (const item of records.filter((r) => r.pid)) assert.throws(() => process.kill(item.pid, 0));
  await instance.close();
  instance = undefined;
  await assert.rejects(
    fetch(`${address}/api/health`),
    'Owned local service must stop with desktop app',
  );
  instance = await launch();
  const reopened = await instance.firstWindow();
  await reopened.getByText('本机服务已连接').waitFor();
  for (let i = 0; i < 100; i++) {
    try {
      if ((await inspect()).count === '1') break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await inspect()).count, '1');
  console.log(
    `Desktop verified: single visible preview, MCP click retry, typing, publish continuity, shutdown and restart. Screenshot: ${screenshot}`,
  );
} finally {
  if (instance) await instance.close();
  await rm(temporary, { recursive: true, force: true });
}
