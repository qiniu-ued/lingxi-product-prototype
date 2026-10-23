import { expect, test } from '@playwright/test';

test('setup detects Codex on request and separates readiness from execution', async ({ page }) => {
  let checks = 0;
  await page.route('**/api/setup/codex/check', async (route) => {
    checks += 1;
    await route.fulfill({
      json: {
        checkedAt: new Date().toISOString(),
        status: checks === 1 ? 'not-installed' : 'ready',
        cliVersion: checks === 1 ? null : '0.164.0',
        authentication: checks === 1 ? null : 'chatgpt',
      },
    });
  });
  await page.goto('/');
  await page.getByRole('link', { name: '连接向导', exact: true }).click();
  await expect(page.getByRole('heading', { name: '把准备工作，一步步做好。' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('工作台服务已响应');
  await page
    .getByRole('navigation', { name: '连接步骤' })
    .getByRole('button', { name: /准备 Codex/ })
    .click();
  expect(checks).toBe(0);
  await expect(
    page.getByText('npm install -g @openai/codex@0.164.0', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '检测 Codex 环境' }).click();
  await expect(page.getByRole('status')).toContainText('未找到 Codex CLI');
  await page.getByRole('button', { name: '检测 Codex 环境' }).click();
  await expect(page.getByRole('status')).toContainText('Codex 环境检查通过');
  await expect(page.getByRole('status')).toContainText('当前版本仍未开放执行任务');
  await page.getByRole('link', { name: '返回工作台', exact: true }).click();
  await expect(page.getByText('Codex 待连接', { exact: true })).toBeVisible();
});

test('setup explains voice preparation and opens a passive display', async ({ page, context }) => {
  await page.goto('/setup');
  await page
    .getByRole('navigation', { name: '连接步骤' })
    .getByRole('button', { name: /准备灵矽语音/ })
    .click();
  await expect(page.getByRole('link', { name: '打开灵矽控制台' })).toHaveAttribute(
    'href',
    'https://xrobo.qiniu.com/',
  );
  await expect(page.getByText('语音控制尚待接入', { exact: true })).toBeVisible();
  await expect(page.getByText(/完成账号和设备绑定不会自动开启语音编程/)).toBeVisible();
  await page
    .getByRole('navigation', { name: '连接步骤' })
    .getByRole('button', { name: /连接大屏/ })
    .click();
  const opened = context.waitForEvent('page');
  await page.getByRole('link', { name: '打开大屏' }).click();
  const display = await opened;
  await expect(display).toHaveURL(/\/display$/);
  await expect(display.getByRole('heading', { name: '项目预览' })).toBeVisible();
  await expect(display.getByRole('link', { name: '连接向导', exact: true })).toHaveCount(0);
  await expect(display.getByRole('button', { name: '保存修改建议' })).toHaveCount(0);
});

test('failed diagnostics can be retried without claiming readiness', async ({ page }) => {
  await page.route('**/api/setup/codex/check', (route) => route.abort('failed'));
  await page.goto('/setup');
  await page
    .getByRole('navigation', { name: '连接步骤' })
    .getByRole('button', { name: /准备 Codex/ })
    .click();
  await page.getByRole('button', { name: '检测 Codex 环境' }).click();
  await expect(page.getByRole('alert')).toContainText('未收到检测结果');
  await expect(page.getByRole('button', { name: '检测 Codex 环境' })).toBeEnabled();
  await expect(page.getByText('Codex 环境检查通过', { exact: true })).toHaveCount(0);
});
