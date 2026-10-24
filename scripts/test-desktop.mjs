import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
const launch = (directory = dataRoot) =>
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
      LINGXI_DESKTOP_DATA: directory,
      LINGXI_CODEX_BIN: fixture,
      LINGXI_TASK_FIXTURE_MODE: 'browser',
      LINGXI_TASK_FIXTURE_RECORD: record,
      XDG_CACHE_HOME: join(temporary, 'cache'),
    },
    timeout: 25000,
  });
async function expand(page, selector) {
  const details = page.locator(selector);
  if (!(await details.evaluate((element) => element.open))) {
    await details.locator(':scope > summary').focus();
    await details.locator(':scope > summary').press('Enter');
  }
  assert.equal(await details.evaluate((element) => element.open), true);
}
async function assertAgentDensity(page) {
  const agent = await page.locator('.live-activity').evaluate((element) => ({
    open: element.open,
    height: element.querySelector('summary').getBoundingClientRect().height,
    iconHeight: element.querySelector('.agent-icon').getBoundingClientRect().height,
    statusHeight: element.querySelector('.agent-state').getBoundingClientRect().height,
    viewportHeight: innerHeight,
  }));
  assert.equal(agent.open, false, 'Actual Agent details must start collapsed');
  const compact = agent.viewportHeight <= 850;
  // Prototype row = max(icon, 12px text × 1.6 line height + 2px status padding per side)
  // plus 2px (compact) or 6px (regular) row padding per side.
  const agentLimit = Math.max(compact ? 22 : 28, 12 * 1.6 + 2 * 2) + (compact ? 2 : 6) * 2;
  assert.ok(
    agent.height <= agentLimit + 1,
    `Agent summary must match the prototype density: ${JSON.stringify(agent)}`,
  );
}
try {
  instance = await launch();
  const operator = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.setContentSize(1440, 940);
  });
  await operator.getByRole('heading', { name: '先检查，再配置。', exact: true }).waitFor();
  assert.equal(new URL(operator.url()).pathname, '/setup');
  await operator.getByRole('button', { name: '暂时用文字进入工作台', exact: true }).first().click();
  await operator.getByText('本机服务已连接').waitFor();
  for (const selector of ['.workbench-menu', '.keyboard-composer'])
    assert.equal(
      await operator.locator(selector).evaluate((element) => element.open),
      false,
      `${selector} must start collapsed`,
    );
  const address = new URL(operator.url()).origin;
  await expand(operator, '.keyboard-composer');
  await operator.getByLabel('模型', { exact: true }).selectOption('test-model');
  await operator.getByLabel('Reasoning Effort', { exact: true }).selectOption('high');
  const beforeTasks = await readFile(record, 'utf8');
  assert.ok(!beforeTasks.includes('thread/start'), 'Loading model choices must not start a thread');
  await operator.getByLabel('工作模式', { exact: true }).selectOption('plan');
  await operator.waitForFunction(
    () => document.querySelector('#collaboration-mode').value === 'plan',
  );
  await operator.getByLabel('工作模式', { exact: true }).selectOption('default');
  await operator.waitForFunction(
    () => document.querySelector('#collaboration-mode').value === 'default',
  );
  await operator.getByText('模式说明与兼容验证', { exact: true }).click();
  await operator.getByRole('button', { name: '验证执行设置', exact: true }).click();
  await operator.getByText(/已由 Codex 确认：计划模式、执行模式/).waitFor();
  await operator.getByText('模式说明与兼容验证', { exact: true }).click();
  await operator.locator('.keyboard-composer > summary').press('Enter');

  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await (await fetch(`${address}/api/workbench`)).json();
    if (current.preview) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const before = await (await fetch(`${address}/api/workbench`)).json();
  assert.ok(before.preview);
  let previews = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    previews = await instance.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((w) => w.getURL().startsWith('lingxi-preview:'))
        .map((w) => ({ id: w.id, url: w.getURL(), loading: w.isLoadingMainFrame() })),
    );
    if (previews.length === 1 && previews[0].url === before.preview.url && !previews[0].loading)
      break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(previews.length, 1);
  assert.equal(previews[0].url, before.preview.url);
  assert.equal(previews[0].loading, false);
  const isolation = await instance.evaluate(async ({ webContents }) => {
    const page = webContents
      .getAllWebContents()
      .find((w) => w.getURL().startsWith('lingxi-preview:'));
    return page.executeJavaScript(`({desktop:typeof window.lingxiDesktop,node:typeof process})`);
  });
  assert.deepEqual(isolation, { desktop: 'undefined', node: 'undefined' });
  await operator.getByRole('button', { name: '批注修改', exact: true }).click();
  await operator
    .getByRole('img', { name: '大屏中同一个作品页面的实时画面' })
    .click({ position: { x: 150, y: 65 } });
  await operator.getByRole('button', { name: '清除选择' }).waitFor();
  await operator
    .getByLabel('给选中元素的批注', { exact: true })
    .fill('保留这段文字，把背景改成粉色');
  await expand(operator, '.keyboard-composer');
  await operator.getByLabel('给 Codex 的本轮指令').fill('vote and type');
  await operator.getByRole('button', { name: '提交给 Codex' }).click();
  let after;
  for (let attempt = 0; attempt < 150; attempt++) {
    after = await (await fetch(`${address}/api/workbench`)).json();
    if (after.task && ['completed', 'failed'].includes(after.task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(after.task.status, 'completed', JSON.stringify(after.task));
  assert.ok(after.task.prompt.includes('保留这段文字，把背景改成粉色'));
  assert.equal(after.task.settings.model, 'test-model');
  assert.equal(after.task.settings.effort, 'high');
  const started = (await readFile(record, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((message) => message.method === 'turn/start');
  assert.equal(started.params.collaborationMode.mode, 'default');
  assert.equal(started.params.approvalsReviewer, 'user');
  const summary = operator.getByRole('region', { name: '本轮用量摘要', exact: true }).first();
  await summary.waitFor();
  assert.ok((await summary.textContent()).includes('150,000 Token used'));
  assert.equal(
    await operator
      .getByRole('meter', { name: '当前上下文占用', exact: true })
      .getAttribute('aria-valuetext'),
    '25.0% 已使用',
  );
  const reply = operator.locator('[data-history-role="assistant"]').first();
  await reply.selectText();
  await reply.dispatchEvent('mouseup');
  await operator.getByRole('button', { name: '引用到对话', exact: true }).click();
  await operator
    .locator('.context-attachments')
    .getByText('引用原文：', { exact: false })
    .waitFor();
  assert.ok((await operator.locator('.context-attachments').textContent()).includes('本轮已完成'));
  await operator
    .locator('.context-attachments')
    .getByRole('button', { name: '移除', exact: true })
    .click();
  await operator.getByLabel('给 Codex 的本轮指令').fill('主对话草稿保留');
  await expand(operator, '.workbench-menu');
  await operator.getByRole('button', { name: '连接向导', exact: true }).click();
  await operator.getByRole('button', { name: '设置', exact: true }).click();
  await operator.getByRole('heading', { name: '配置与连接', exact: true }).waitFor();
  await operator.getByRole('navigation', { name: '设置分类' }).waitFor();
  await operator.getByRole('heading', { name: 'Codex 环境检查通过', exact: true }).waitFor();
  await operator.screenshot({ path: join(root, '.local/settings-smoke.png') });
  assert.equal((await (await fetch(`${address}/api/workbench`)).json()).task.id, after.task.id);
  await operator.getByRole('button', { name: '返回工作台', exact: true }).click();
  assert.equal(await operator.getByLabel('给 Codex 的本轮指令').inputValue(), '主对话草稿保留');
  await reply.selectText();
  await reply.dispatchEvent('mouseup');
  await operator.getByRole('button', { name: '选段 Sidechat', exact: true }).click();
  await operator.waitForFunction(
    () => document.querySelector('#permission-mode').value === 'sidechat',
  );
  assert.equal(await operator.getByLabel('给 Codex 的本轮指令').inputValue(), '');
  assert.ok((await operator.locator('.context-attachments').textContent()).includes('本轮已完成'));
  const discussion = await (await fetch(`${address}/api/workbench`)).json();
  assert.equal(discussion.task, null, 'Selecting Sidechat must not submit a model task');
  await expand(operator, '.workbench-menu');
  await operator.getByLabel('切换对话').selectOption(after.task.conversationId);
  await operator.locator('.workbench-menu > summary').press('Enter');
  assert.equal(await operator.getByLabel('给 Codex 的本轮指令').inputValue(), '主对话草稿保留');
  await operator.getByLabel('给 Codex 的本轮指令').fill('');
  assert.equal(await operator.locator('.context-attachments').count(), 0);
  await operator.locator('.keyboard-composer > summary').press('Enter');
  await operator.getByRole('button', { name: '复制本轮回复', exact: true }).first().click();
  assert.ok(
    (await instance.evaluate(({ clipboard }) => clipboard.readText())).includes('本轮已完成'),
  );
  assert.equal(await operator.getByRole('button', { name: 'Sidechat', exact: true }).count(), 0);
  assert.equal(await operator.getByRole('button', { name: '添加到对话', exact: true }).count(), 0);
  await operator.getByRole('button', { name: '上下文使用详情', exact: true }).hover();
  await operator.getByRole('tooltip').waitFor();
  assert.equal(
    await operator.getByRole('tooltip').evaluate((node) => getComputedStyle(node).backgroundColor),
    'rgb(54, 51, 45)',
  );
  await operator.screenshot({ path: join(root, '.local/context-tooltip.png') });
  await operator.getByRole('button', { name: '上下文使用详情', exact: true }).click();
  await operator.getByRole('table').waitFor();
  await operator.getByRole('button', { name: '上下文使用详情', exact: true }).click();
  await operator.waitForFunction(() =>
    document.querySelector('.turn-usage')?.textContent.includes('35.7% Cache hit.'),
  );
  await expand(operator, '.keyboard-composer');
  await operator.getByLabel('模型', { exact: true }).selectOption('fast-model');
  await operator.waitForFunction(() => document.querySelector('#codex-effort').value === 'low');
  assert.equal(await operator.locator('#codex-effort option[value="high"]').count(), 0);
  await operator.locator('.keyboard-composer > summary').press('Enter');

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
  await expand(operator, '.project-menu');
  await operator.getByRole('button', { name: '刷新作品' }).click();
  assert.equal(await operator.locator('.project-menu').evaluate((element) => element.open), false);
  for (let i = 0; i < 100; i++) {
    const current = await (await fetch(`${address}/api/workbench`)).json();
    if (current.preview?.revision > before.preview.revision) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal((await inspect()).count, '1');
  await expand(operator, '.keyboard-composer');
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
  const canonicalProject = await realpath(projectPath);
  const persistent = records.filter((r) => r.pid && r.cwd === canonicalProject);
  const probes = records.filter((r) => r.pid && r.cwd !== canonicalProject);
  assert.equal(persistent.length, 1, 'One persistent task connection must remain owned by the app');
  assert.equal(
    probes.length,
    3,
    'Startup, settings diagnostics and explicit verification must use temporary connections',
  );
  for (const item of persistent) assert.doesNotThrow(() => process.kill(item.pid, 0));
  for (const item of probes)
    assert.throws(() => process.kill(item.pid, 0), 'Verification peer must already be stopped');
  await instance.close();
  instance = undefined;
  for (const item of records.filter((r) => r.pid)) assert.throws(() => process.kill(item.pid, 0));
  await assert.rejects(
    fetch(`${address}/api/health`),
    'Owned local service must stop with desktop app',
  );
  instance = await launch();
  const reopened = await instance.firstWindow();
  await reopened.getByRole('button', { name: '暂时用文字进入工作台', exact: true }).first().click();
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
  await expand(reopened, '.workbench-menu');
  await reopened.getByRole('button', { name: '终端', exact: true }).click();
  await reopened.getByRole('button', { name: '打开终端', exact: true }).click();
  await reopened.getByText('项目终端 · running', { exact: false }).waitFor();
  await reopened.locator('.xterm-helper-textarea').pressSequentially('pwd');
  await reopened.locator('.xterm-helper-textarea').press('Enter');
  await reopened.getByRole('button', { name: '结束终端', exact: true }).click();
  await reopened.getByText('项目终端 · exited', { exact: false }).waitFor();
  await expand(reopened, '.workbench-menu');
  await reopened.getByRole('button', { name: 'Diff', exact: true }).click();
  await reopened.locator('.diff-lines button').filter({ hasText: '+new' }).click();
  await reopened.getByLabel('Diff 评论').fill('请调整这一行');
  await reopened
    .locator('.workspace-tool')
    .getByRole('button', { name: '添加到对话', exact: true })
    .click();
  await reopened.locator('.context-attachments').getByText('Codex 本轮变更').waitFor();
  await reopened.locator('.context-attachments').getByRole('button', { name: '移除' }).click();
  await reopened.locator('.keyboard-composer > summary').press('Enter');
  await expand(reopened, '.workbench-menu');
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
  await expand(reopened, '.workbench-menu');
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
  await expand(reopened, '.keyboard-composer');
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
  for (const selector of ['.workbench-menu', '.keyboard-composer'])
    assert.equal(
      await reopened.locator(selector).evaluate((element) => element.open),
      false,
      `${selector} must be collapsed after submission`,
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
  await assertAgentDensity(reopened);
  const steps = await reopened
    .locator('.conversation-turn details')
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.querySelector('summary')?.textContent.startsWith('执行步骤'))
        .map((element) => element.open),
    );
  assert.ok(steps.length > 0, 'Fixture execution steps must be present');
  assert.ok(
    steps.every((open) => !open),
    'Execution steps must start collapsed',
  );
  const displayPage = (await instance.windows()).find(
    (page) => new URL(page.url()).pathname === '/display',
  );
  assert.ok(displayPage);
  for (const [width, height] of [
    [1440, 940],
    [998, 767],
    [907, 683],
  ]) {
    await instance.evaluate(
      ({ BrowserWindow }, size) => {
        for (const window of BrowserWindow.getAllWindows()) window.setContentSize(...size);
      },
      [width, height],
    );
    await displayPage.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const expectedBounds = await displayPage.locator('.live-viewport').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.floor(bounds.width),
        height: Math.floor(bounds.height),
      };
    });
    const expectedImage = await reopened.evaluate(async () => {
      const snapshot = await window.lingxiDesktop.snapshot();
      const image = new Image();
      image.src = `data:image/png;base64,${snapshot.image}`;
      await image.decode();
      return {
        width: snapshot.width,
        height: snapshot.height,
        pixelWidth: image.naturalWidth,
        pixelHeight: image.naturalHeight,
      };
    });
    const pixelRatio = await displayPage.evaluate(() => devicePixelRatio);
    assert.equal(expectedImage.width, Math.round(expectedBounds.width * pixelRatio));
    assert.equal(expectedImage.height, Math.round(expectedBounds.height * pixelRatio));
    await reopened.waitForFunction(
      ({ pixelWidth, pixelHeight }) => {
        const image = document.querySelector('.preview-pick img');
        return image?.naturalWidth === pixelWidth && image?.naturalHeight === pixelHeight;
      },
      expectedImage,
      { timeout: 5000 },
    );
    for (const [name, page] of [
      ['operator', reopened],
      ['display', displayPage],
    ]) {
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const current = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        bodyWidth: document.body.scrollWidth,
        bodyHeight: document.body.scrollHeight,
        preview: document.querySelector('.live-viewport').getBoundingClientRect().bottom,
        footer: document.querySelector('.live-footer').getBoundingClientRect().top,
        imageWidth: document.querySelector('.preview-pick img')?.naturalWidth,
        imageHeight: document.querySelector('.preview-pick img')?.naturalHeight,
      }));
      assert.ok(
        current.preview <= current.footer &&
          current.bodyWidth <= current.width &&
          current.bodyHeight <= current.height,
        `Desktop ${name} must fit one screen: ${JSON.stringify(current)}`,
      );
      await assertAgentDensity(page);
      const screenshotPath = join(root, `.local/desktop-${name}-${width}x${height}.png`);
      await page.screenshot({ path: screenshotPath });
      if (name === 'display') {
        const native = await instance.evaluate(async ({ BrowserWindow }, url) => {
          const window = BrowserWindow.getAllWindows().find(
            (value) => new URL(value.webContents.getURL()).pathname === '/display',
          );
          const view = window.contentView.children.find(
            (value) => value.webContents?.getURL() === url,
          );
          return {
            bounds: view.getBounds(),
            image: (await view.webContents.capturePage()).toPNG().toString('base64'),
          };
        }, liveUrl);
        assert.deepEqual(
          native.bounds,
          expectedBounds,
          'Native preview must match its visible panel',
        );
        await writeFile(
          join(root, `.local/desktop-preview-${width}x${height}.png`),
          Buffer.from(native.image, 'base64'),
        );
      }
      console.log(`Desktop ${name} ${width}x${height}: ${JSON.stringify(current)}`);
    }
  }
  await reopened.goto(`${reopenedAddress}/setup`);
  await reopened
    .getByRole('button', { name: /配置丽塔同学/ })
    .first()
    .click();
  await reopened.getByRole('button', { name: '获取本机绑定码', exact: true }).waitFor();
  assert.equal(
    await reopened
      .getByRole('link', { name: '打开七牛语音控制台 ↗', exact: true })
      .getAttribute('href'),
    'https://xrobo.qiniu.com/',
  );
  await reopened.getByText('配置语音工作台角色', { exact: true }).click();
  await reopened.getByRole('button', { name: '复制角色说明', exact: true }).click();
  const role = await instance.evaluate(({ clipboard }) => clipboard.readText());
  assert.ok(role.includes('workbench_submit') && role.includes('把这个页面变成粉色'));
  assert.equal(
    (await (await fetch(`${reopenedAddress}/api/voice`)).json()).allowVoiceSubmit,
    false,
    'Viewing binding instructions and copying the role must not enable voice execution',
  );
  await reopened.screenshot({ path: join(root, '.local/voice-setup-smoke.png') });
  await reopened
    .getByRole('navigation', { name: '连接步骤' })
    .getByRole('button', { name: /配置唤醒模型/ })
    .click();
  await reopened
    .getByRole('button', { name: '下载本地唤醒模型（约 33 MB）', exact: true })
    .waitFor();
  await reopened.screenshot({ path: join(root, '.local/wake-setup-smoke.png') });
  await instance.close();
  instance = undefined;
  const emptyData = join(temporary, 'empty-data');
  await mkdir(emptyData);
  instance = await launch(emptyData);
  const emptyOperator = await instance.firstWindow();
  await emptyOperator.getByRole('heading', { name: '先检查，再配置。', exact: true }).waitFor();
  await emptyOperator.waitForFunction(async () => {
    const state = await (await fetch('/api/workbench')).json();
    return state.project === null;
  });
  const defaultDisplay = await instance
    .waitForEvent('window', { predicate: (page) => page.url().endsWith('/display'), timeout: 3000 })
    .catch(() => null);
  const windows = await instance.windows();
  assert.ok(
    defaultDisplay || windows.some((page) => page.url().endsWith('/display')),
    'A fresh installation must open the display without a project or AirPlay',
  );
  console.log(
    `Desktop verified: canonical static/live preview, MCP retry, terminal, diff context, PCM worklet, device wizard, shutdown and restart. Screenshot: ${screenshot}`,
  );
} finally {
  if (instance) await instance.close();
  if (liveServer) await new Promise((resolve) => liveServer.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
