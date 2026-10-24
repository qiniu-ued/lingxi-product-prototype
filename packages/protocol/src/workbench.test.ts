import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  desktopActionSchema,
  historyQuoteSchema,
  previewActionSchema,
  startTaskSchema,
  taskSchema,
  workspaceCommandSchema,
} from './workbench.js';

it('keeps native and browser actions closed to arbitrary paths and scripts', () => {
  expect(
    desktopActionSchema.safeParse({ action: 'select-project', path: '/private' }).success,
  ).toBe(false);
  expect(previewActionSchema.safeParse({ action: 'eval', script: 'arbitrary code' }).success).toBe(
    false,
  );
  expect(
    previewActionSchema.safeParse({ action: 'snapshot', url: 'https://another-page' }).success,
  ).toBe(false);
  expect(
    startTaskSchema.safeParse({ requestId: randomUUID(), text: ' ', cwd: '/private' }).success,
  ).toBe(false);
  expect(startTaskSchema.parse({ requestId: randomUUID(), text: ' change ' }).text).toBe('change');
});
it('reads pre-selection v1 task records with a null target', () => {
  const time = new Date().toISOString();
  expect(
    taskSchema.parse({
      id: randomUUID(),
      projectId: randomUUID(),
      prompt: 'work',
      status: 'interrupted',
      threadId: null,
      turnId: null,
      messages: [],
      activity: 'stopped',
      approval: null,
      error: null,
      createdAt: time,
      updatedAt: time,
    }).selection,
  ).toBeNull();
});
it('limits history excerpts and accepts them only as optional fork command input', () => {
  const quote = { taskId: randomUUID(), role: 'assistant', messageId: 'reply', text: '段落' };
  expect(
    workspaceCommandSchema.parse({ action: 'fork', kind: 'sidechat', taskId: quote.taskId, quote }),
  ).toHaveProperty('quote.text', '段落');
  expect(historyQuoteSchema.safeParse({ ...quote, text: ' ' }).success).toBe(false);
  expect(historyQuoteSchema.safeParse({ ...quote, text: 'x'.repeat(16001) }).success).toBe(false);
  expect(historyQuoteSchema.safeParse({ ...quote, script: 'arbitrary' }).success).toBe(false);
});
