import type { CodexCheck, CodexSetupAction } from '@lingxi/protocol';
import { expect, type Page, test } from '@playwright/test';

const check = (status: CodexCheck['status']): CodexCheck => ({
  checkedAt: new Date().toISOString(),
  status,
  cliVersion: status === 'not-installed' ? null : '0.999.0',
  authentication: status === 'ready' ? 'chatgpt' : null,
});
async function inspection(page: Page, status: CodexCheck['status'] = 'not-installed') {
  await page.route('**/api/setup/check', (route) =>
    route.fulfill({
      json: {
        environment: {
          checkedAt: new Date().toISOString(),
          host: { platform: 'darwin', arch: 'arm64', nodeVersion: '24.11.0', nodeSupported: true },
          capabilities: { codexTasks: false, lingxiVoice: false },
        },
        codex: check(status),
        lingxi: {
          checkedAt: new Date().toISOString(),
          status: 'unavailable',
          reason: 'adapter-not-connected',
        },
      },
    }),
  );
}
function fixtureAction(
  kind: 'install' | 'login',
  state: CodexSetupAction['state'],
): CodexSetupAction {
  return {
    id: '3f531af4-c454-4b04-badc-e91d1e6ae2d4',
    kind,
    state,
    error: null,
    authUrl: null,
    check: null,
    updatedAt: new Date().toISOString(),
  };
}

test('one inspection reports both tools before offering only the missing steps', async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await inspection(page);
  await page.route('**/api/setup/check', async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto('/');
  await page.getByRole('link', { name: '连接向导', exact: true }).click();
  await expect(page.getByText('正在检查 Codex 和灵矽…', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '连接步骤' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '一键安装最新版 Codex' })).toHaveCount(0);
  release();
  const results = page.getByRole('region', { name: '环境检查结果' });
  await expect(results).toContainText('未找到 Codex CLI');
  await expect(results).toContainText('需在桌面版检测灵矽');
  await expect(page.getByRole('button', { name: '一键安装最新版 Codex' })).toBeVisible();
  await expect(page.getByRole('button', { name: '在浏览器登录 Codex' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '连接步骤' }).getByRole('button')).toHaveCount(
    2,
  );
  await expect(page.getByText('git clone', { exact: false })).toHaveCount(0);
  await page.getByText('使用终端配置或排查问题', { exact: true }).click();
  await expect(
    page.getByText('npm install -g @openai/codex@latest', { exact: true }),
  ).toBeVisible();
});

test('existing signed-in Codex skips installation and suggests Lingxi preparation', async ({
  page,
}) => {
  await inspection(page, 'ready');
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: '配置灵矽', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '打开灵矽控制台' })).toHaveAttribute(
    'href',
    'https://xrobo.qiniu.com/',
  );
  await expect(page.getByRole('button', { name: '获取本机绑定码', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: '连接步骤' })
    .getByRole('button', { name: /配置 Codex/ })
    .click();
  await expect(page.getByRole('button', { name: '一键安装最新版 Codex' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '在浏览器登录 Codex' })).toHaveCount(0);
  await expect(page.getByText(/当前浏览器入口可保存建议和同步大屏/).first()).toBeVisible();
});

test('installs only after clicking and proceeds to login after verification', async ({ page }) => {
  await inspection(page);
  let current: CodexSetupAction | null = null;
  let requests = 0;
  await page.route('**/api/setup/codex/action', async (route) => {
    if (route.request().method() === 'POST') {
      requests++;
      expect(route.request().postDataJSON()).toMatchObject({
        kind: 'install',
        requestId: expect.any(String),
      });
      current = fixtureAction('install', 'installing');
    }
    await route.fulfill({ json: { action: current } });
  });
  await page.goto('/setup');
  await expect(page.getByRole('button', { name: '一键安装最新版 Codex' })).toBeVisible();
  expect(requests).toBe(0);
  await page.getByRole('button', { name: '一键安装最新版 Codex' }).click();
  await expect(page.getByText('正在下载并安装最新版 Codex…')).toBeVisible();
  current = { ...fixtureAction('install', 'succeeded'), check: check('signed-out') };
  await expect(page.getByRole('button', { name: '在浏览器登录 Codex' })).toBeVisible();
  await expect(page.getByRole('button', { name: '一键安装最新版 Codex' })).toHaveCount(0);
  expect(requests).toBe(1);
});

test('opens only the official OAuth URL and reports verified login completion', async ({
  page,
  context,
}) => {
  await inspection(page, 'signed-out');
  let current: CodexSetupAction | null = null;
  await context.route('https://auth.openai.com/**', (route) =>
    route.fulfill({ body: '<p>Fixture authorization page</p>' }),
  );
  await page.route('**/api/setup/codex/action', async (route) => {
    if (route.request().method() === 'POST')
      current = {
        ...fixtureAction('login', 'waiting-for-login'),
        authUrl: 'https://auth.openai.com/authorize?fixture=1',
      };
    await route.fulfill({ json: { action: current } });
  });
  await page.goto('/setup');
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: '在浏览器登录 Codex' }).click();
  const authorization = await opened;
  await expect(authorization).toHaveURL('https://auth.openai.com/authorize?fixture=1');
  await expect(page.getByRole('link', { name: '打开官方授权页' })).toBeVisible();
  current = { ...fixtureAction('login', 'succeeded'), check: check('ready') };
  await expect(page.getByText('官方授权已完成，认证配置复查通过。')).toBeVisible();
  await expect(page.getByRole('button', { name: '在浏览器登录 Codex' })).toHaveCount(0);
  await page.getByRole('link', { name: '返回工作台', exact: true }).click();
  await expect(page.getByText('Codex 待连接', { exact: true })).toBeVisible();
});

test('a refreshed page resumes an action and allows cancellation', async ({ page }) => {
  await inspection(page);
  let current = fixtureAction('install', 'installing');
  await page.route('**/api/setup/codex/action', (route) =>
    route.fulfill({ json: { action: current } }),
  );
  await page.route('**/api/setup/codex/check', (route) =>
    route.fulfill({ json: check('not-installed') }),
  );
  await page.route('**/api/setup/codex/cancel', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ id: current.id });
    current = { ...current, state: 'cancelling' };
    await route.fulfill({ json: { action: current } });
    current = { ...current, state: 'cancelled' };
  });
  await page.goto('/setup');
  await expect(page.getByText('正在下载并安装最新版 Codex…')).toBeVisible();
  await page.reload();
  await expect(page.getByText('正在下载并安装最新版 Codex…')).toBeVisible();
  await page.getByRole('button', { name: '停止安装' }).click();
  await expect(page.getByText('已停止本次操作', { exact: true })).toBeVisible();
});

test('inspection failures can be retried before configuration is shown', async ({ page }) => {
  await page.route('**/api/setup/check', (route) => route.abort('failed'));
  await page.goto('/setup');
  await expect(page.getByRole('alert')).toContainText('未收到检测结果');
  await expect(page.getByRole('navigation', { name: '连接步骤' })).toHaveCount(0);
  await page.unroute('**/api/setup/check');
  await inspection(page, 'signed-out');
  await page.getByRole('button', { name: '重新检查环境' }).click();
  await expect(page.getByRole('button', { name: '在浏览器登录 Codex' })).toBeVisible();
});

test('device wizard gets an activation code and confirms binding without asking for a copied token', async ({
  page,
}) => {
  await inspection(page, 'ready');
  await page.addInitScript(() =>
    Object.defineProperty(window, 'lingxiDesktop', {
      value: {
        info: async () => ({ platform: 'darwin', arch: 'arm64', systemVersion: 'test-system' }),
        onAudio: () => () => {},
      },
    }),
  );
  const actions: string[] = [];
  await page.route('**/api/voice/binding', async (route) => {
    const { action } = route.request().postDataJSON() as { action: string };
    actions.push(action);
    await route.fulfill({
      json: {
        status: action === 'start' ? 'waiting' : 'bound',
        deviceId: '02:12:34:56:78:90',
        clientId: 'b328db8c-5dfa-4389-9035-3cd43b2868d2',
        code: action === 'start' ? '608303' : null,
        error: null,
      },
    });
  });
  await page.goto('/setup');
  await page.getByRole('button', { name: '获取本机绑定码', exact: true }).click();
  await expect(page.getByRole('status', { name: '设备激活码' })).toHaveText('608303');
  await page.getByRole('button', { name: '我已绑定，检查连接配置', exact: true }).click();
  await expect(page.getByText(/绑定已确认，连接配置已加密保存/)).toBeVisible();
  expect(actions).toEqual(['start', 'check']);
  await expect(page.getByLabel('设备访问令牌')).not.toBeVisible();
});
