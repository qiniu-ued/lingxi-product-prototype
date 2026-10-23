import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('a lost save response can be retried without duplicating the suggestion', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('实时同步');
  await page.route(
    '**/api/commands',
    async (route) => {
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  const text = `保留这次提交 ${randomUUID()}`;
  await page.getByLabel('添加修改建议').fill(text);
  await page.getByRole('button', { name: '保存修改建议' }).click();
  await expect(page.getByRole('alert')).toContainText('输入已保留');
  await expect(page.getByLabel('添加修改建议')).toHaveValue(text);
  await page.getByRole('button', { name: '保存修改建议' }).click();
  await expect(page.getByLabel('添加修改建议')).toHaveValue('');
  await expect(page.getByLabel('已保存的修改建议').getByText(text)).toHaveCount(1);
});

test('computer and display share durable suggestions without claiming agent execution', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('实时同步');
  const display = await context.newPage();
  await display.setViewportSize({ width: 1920, height: 1080 });
  await display.goto('/display');
  await expect(display.getByRole('status')).toHaveText('实时同步');
  const text = `把标题改成一起出发 ${randomUUID()}`;
  await page.getByLabel('添加修改建议').fill(text);
  await page.getByRole('button', { name: '保存修改建议' }).click();
  await expect(page.getByLabel('已保存的修改建议').getByText(text)).toBeVisible();
  await expect(display.getByLabel('已保存的修改建议').getByText(text)).toBeVisible();
  await expect(display.getByRole('button', { name: '保存修改建议' })).toHaveCount(0);
  await expect(display.getByText('Codex 待连接')).toBeVisible();
  await expect(display.getByText('建议会保存在本机，目前尚未执行。')).toBeVisible();
  await display.reload();
  await expect(display.getByLabel('已保存的修改建议').getByText(text)).toBeVisible();
});

test('display keeps its last picture offline and catches up after reconnect', async ({
  page,
  browser,
}) => {
  await page.goto('/display');
  await expect(page.getByRole('status')).toHaveText('实时同步');
  await page.context().setOffline(true);
  await expect(page.getByRole('status')).toHaveText('连接中断 · 正在重连');
  await expect(page.getByRole('heading', { name: '项目预览' })).toBeVisible();
  const writerContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const writer = await writerContext.newPage();
    await writer.goto('/');
    await expect(writer.getByRole('status')).toHaveText('实时同步');
    const text = `恢复连接后的建议 ${randomUUID()}`;
    await writer.getByLabel('添加修改建议').fill(text);
    await writer.getByRole('button', { name: '保存修改建议' }).click();
    await expect(writer.getByLabel('已保存的修改建议').getByText(text)).toBeVisible();
    await page.context().setOffline(false);
    await expect(page.getByRole('status')).toHaveText('实时同步', { timeout: 15000 });
    await expect(page.getByLabel('已保存的修改建议').getByText(text)).toBeVisible();
  } finally {
    await writerContext.close();
  }
});
