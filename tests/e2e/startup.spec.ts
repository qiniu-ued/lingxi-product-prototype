import { type SetupInspection, voiceStateSchema } from '@lingxi/protocol';
import { expect, type Page, test } from '@playwright/test';

function ready(): SetupInspection {
  const checkedAt = new Date().toISOString();
  return {
    environment: {
      checkedAt,
      host: { platform: 'darwin', arch: 'arm64', nodeVersion: '24.11.0', nodeSupported: true },
      capabilities: { codexTasks: true, lingxiVoice: true },
    },
    codex: { checkedAt, status: 'ready', cliVersion: '0.999.0', authentication: 'chatgpt' },
    lingxi: { checkedAt, status: 'configured', reason: 'configuration-saved' },
    wake: { checkedAt, status: 'ready', reason: 'model-ready' },
    microphone: 'not-determined',
  };
}
async function fixture(page: Page, initial = ready(), failing = false) {
  let inspection = initial,
    checks = 0;
  const actions: string[] = [];
  let voice = voiceStateSchema.parse({
    configured: true,
    status: 'disconnected',
    draft: '',
    captureId: null,
    subtitle: '',
    error: null,
    allowVoiceSubmit: false,
    wake: {
      status: 'off',
      keyword: '丽塔同学',
      installed: initial.wake?.status === 'ready',
      detectionId: null,
      error: null,
    },
  });
  await page.addInitScript(() =>
    Object.defineProperty(window, 'lingxiDesktop', {
      value: {
        info: async () => ({ platform: 'darwin', arch: 'arm64', systemVersion: 'fixture' }),
        onAudio: () => () => {},
        microphone: async () => {
          Reflect.set(
            window,
            'microphoneRequests',
            (Reflect.get(window, 'microphoneRequests') ?? 0) + 1,
          );
          return true;
        },
      },
    }),
  );
  await page.route('**/api/setup/check', (route) => {
    checks++;
    return route.fulfill(failing ? { status: 503, json: {} } : { json: inspection });
  });
  await page.route('**/api/setup/codex/action', (route) =>
    route.fulfill({ json: { action: null } }),
  );
  await page.route('**/api/voice', (route) => route.fulfill({ json: voice }));
  await page.route('**/api/voice/inspect', (route) => route.fulfill({ json: voice }));
  await page.route('**/api/voice/command', (route) => {
    const body = route.request().postDataJSON();
    actions.push(body.action);
    if (body.action === 'install-wake') {
      voice = { ...voice, wake: { ...voice.wake, installed: true } };
      inspection = {
        ...inspection,
        wake: { checkedAt: new Date().toISOString(), status: 'ready', reason: 'model-ready' },
      };
    }
    return route.fulfill({ json: voice });
  });
  return {
    actions,
    checks: () => checks,
    recover: () => {
      failing = false;
    },
  };
}
test('desktop startup checks configuration before mounting the workspace; passive display never runs setup', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/');
  await expect(page.getByText('本机服务已连接', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '先检查，再配置。' })).toHaveCount(0);
  expect(f.checks()).toBeGreaterThan(0);
  const before = f.checks();
  await page.goto('/display');
  await expect(page.getByText('本机服务已连接', { exact: true })).toBeVisible();
  expect(f.checks()).toBe(before);
  expect(f.actions).toEqual([]);
  expect(await page.evaluate(() => Reflect.get(window, 'microphoneRequests'))).toBeUndefined();
});
test('startup sends all configuration problems to the wizard without installing, logging in or asking for microphone access', async ({
  page,
}) => {
  const report = ready();
  report.codex.status = 'signed-out';
  report.lingxi = { ...report.lingxi, status: 'not-configured', reason: 'device-binding-required' };
  report.wake = {
    checkedAt: new Date().toISOString(),
    status: 'not-installed',
    reason: 'model-missing',
  };
  report.microphone = 'denied';
  const f = await fixture(page, report);
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  const overview = page.getByRole('region', { name: '环境检查结果' });
  await expect(overview).toContainText('Codex 尚未登录');
  await expect(overview).toContainText('需要绑定丽塔同学设备');
  await expect(overview).toContainText('需要下载唤醒模型');
  await page
    .getByRole('navigation', { name: '连接步骤' })
    .getByRole('button', { name: /配置唤醒模型/ })
    .click();
  await expect(page.getByText('麦克风权限被系统阻止', { exact: false })).toBeVisible();
  expect(f.actions).toEqual([]);
  expect(await page.evaluate(() => Reflect.get(window, 'microphoneRequests'))).toBeUndefined();
  await page.getByRole('button', { name: '暂时用文字进入工作台', exact: true }).first().click();
  await expect(page.getByText('本机服务已连接', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/setup$/);
});
test('the model is a visible wizard step, downloads only on click and rechecks readiness without enabling wake', async ({
  page,
}) => {
  const report = ready();
  report.wake = {
    checkedAt: new Date().toISOString(),
    status: 'not-installed',
    reason: 'model-missing',
  };
  const f = await fixture(page, report);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '配置唤醒模型', exact: true })).toBeVisible();
  const download = page.getByRole('button', { name: '下载本地唤醒模型（约 33 MB）', exact: true });
  await expect(download).toBeVisible();
  expect(f.actions).toEqual([]);
  await download.click();
  await expect(page.getByRole('heading', { name: '唤醒模型检查通过', exact: true })).toBeVisible();
  expect(f.actions).toEqual(['install-wake']);
  await expect(page.getByRole('button', { name: '开启语音唤醒', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'microphoneRequests'))).toBeUndefined();
  await page.getByRole('button', { name: '进入工作台', exact: true }).first().click();
  await expect(page.getByText('本机服务已连接', { exact: true })).toBeVisible();
});
test('a failed startup inspection opens a retryable wizard instead of a redirect loop', async ({
  page,
}) => {
  const f = await fixture(page, ready(), true);
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('alert')).toContainText('未收到检测结果');
  expect(f.checks()).toBeLessThanOrEqual(4);
  f.recover();
  await page.getByRole('button', { name: '重新检查环境', exact: true }).click();
  await expect(page.getByRole('heading', { name: '唤醒模型检查通过', exact: true })).toBeVisible();
  expect(f.actions).toEqual([]);
});

test('settings can always be opened directly and remain open after every configuration check succeeds', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/settings#lingxi');
  await expect(page.getByRole('heading', { name: '配置与连接', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '丽塔同学与语音执行', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '重新检查全部配置', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '丽塔同学与语音执行', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/settings#lingxi$/);
  expect(f.actions).toEqual([]);
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(
    page.locator('.live-header').getByRole('button', { name: '设置', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.workbench-menu > summary')).toBeVisible();
});
