import { randomUUID } from 'node:crypto';
import { type Task, voiceConversationSchema } from '@lingxi/protocol';
import { expect, it } from 'vitest';
import { VoiceConversation } from './voice-conversation.js';

const scope = () => ({ sessionId: randomUUID(), projectId: randomUUID(), conversationId: null });
it('normalizes streaming STT and TTS, ignores duplicates/late fragments and keeps final messages', () => {
  const chat = new VoiceConversation(),
    context = scope(),
    capture = randomUUID();
  chat.begin(context, capture);
  expect(chat.transcript(capture, '把页面', false)).toBe(true);
  chat.transcript(capture, '把页面变粉色', true);
  chat.transcript(capture, '把页面', false);
  chat.transcript(capture, '把页面变粉色', true);
  expect(chat.sentence('early')).toBe(false);
  expect(chat.startSpeech(context, capture)).toBe(true);
  expect(chat.startSpeech(context, capture)).toBe(false);
  chat.sentence('先检查页面。');
  chat.sentence('先检查页面。');
  chat.sentence('还没有交给 Codex。');
  chat.stopSpeech();
  expect(chat.sentence('late')).toBe(false);
  expect(chat.stopSpeech()).toBe(false);
  const messages = chat.read().turns[0]?.messages;
  expect(messages).toHaveLength(2);
  expect(messages?.[0]).toMatchObject({ role: 'user', text: '把页面变粉色', state: 'final' });
  expect(messages?.[1]).toMatchObject({
    role: 'assistant',
    text: '先检查页面。\n还没有交给 Codex。',
    state: 'final',
  });
});
it('shows projectless chat and pins speech to its original scope across a project change', () => {
  const chat = new VoiceConversation(),
    capture = randomUUID(),
    context = { ...scope(), projectId: null };
  chat.begin(context, capture);
  chat.transcript(capture, '你好', true);
  chat.startSpeech(context, capture);
  chat.sentence('你好。');
  chat.stopSpeech();
  chat.startSpeech(scope(), capture);
  chat.sentence('另一个项目的播报');
  chat.stopSpeech();
  expect(chat.read().turns).toHaveLength(2);
  expect(chat.read().turns[0]?.projectId).toBeNull();
  expect(chat.read().turns[1]?.captureId).toBeNull();
});
it('associates only accepted task receipts, updates runner outcomes and does not retarget projectless input', () => {
  const chat = new VoiceConversation(),
    context = scope(),
    capture = randomUUID(),
    thread = randomUUID();
  chat.begin(context, capture);
  chat.transcript(capture, '只读检查', true);
  const task = {
    id: capture,
    projectId: context.projectId,
    conversationId: thread,
    threadId: 'codex-thread-external',
    status: 'starting',
  } as Task;
  chat.submitted(capture, task);
  chat.handoff({ captureId: capture, status: 'submitted', taskId: capture, message: '已提交' });
  chat.task({ ...task, status: 'failed' });
  expect(chat.read().turns[0]).toMatchObject({
    conversationId: thread,
    taskStatus: 'failed',
    handoff: { taskId: capture, status: 'submitted' },
  });
  expect(() => voiceConversationSchema.parse(chat.read())).not.toThrow();
  const revision = chat.read().revision;
  chat.task({ ...task, status: 'failed' });
  chat.handoff({ captureId: capture, status: 'submitted', taskId: capture, message: '已提交' });
  expect(chat.read().revision).toBe(revision);
  chat.begin({ ...context, projectId: null }, randomUUID());
  chat.transcript('unknown', 'ignored', true);
  chat.submitted('unknown', task);
  expect(chat.read().turns[0]?.projectId).toBe(context.projectId);
});
it('interrupts unfinished messages, bounds text and turn counts, returns isolated copies and clears', () => {
  const chat = new VoiceConversation(),
    context = scope();
  for (let i = 0; i < 40; i++) {
    const id = randomUUID();
    chat.begin(context, id);
    chat.transcript(id, 'x'.repeat(4000), false);
    chat.startSpeech(context, id);
    chat.sentence('y'.repeat(8000));
    chat.interrupt();
  }
  const view = chat.read();
  expect(view.turns.length).toBeLessThanOrEqual(24);
  expect(
    view.turns.reduce((n, t) => n + t.messages.reduce((m, v) => m + v.text.length, 0), 0),
  ).toBeLessThanOrEqual(64000);
  expect(view.turns[0]?.messages.every((m) => m.state === 'interrupted')).toBe(true);
  view.turns[0]!.messages[0]!.text = 'changed';
  expect(chat.read().turns[0]?.messages[0]?.text).not.toBe('changed');
  chat.clear();
  expect(chat.read().turns).toEqual([]);
});

it('keeps the active assistant message when a late user transcript reaches a full turn', () => {
  const chat = new VoiceConversation(),
    context = scope(),
    capture = randomUUID();
  chat.begin(context, capture);
  for (let i = 0; i < 7; i++) {
    chat.startSpeech(context, capture);
    chat.sentence(`句子${i}`);
    chat.stopSpeech();
  }
  chat.startSpeech(context, capture);
  chat.sentence('当前播报');
  chat.transcript(capture, '迟到的转写', true);
  chat.sentence('仍可继续');
  chat.stopSpeech();
  const messages = chat.read().turns[0]?.messages;
  expect(messages).toHaveLength(8);
  expect(messages?.[0]?.role).toBe('user');
  expect(messages?.at(-1)).toMatchObject({ text: '当前播报\n仍可继续', state: 'final' });
});
