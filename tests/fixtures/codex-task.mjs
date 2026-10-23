#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
// Deterministic App Server peer. No model/provider login, real Codex or cloud calls.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [argMode, argRecord] = process.argv.slice(2);
const mode = process.env.LINGXI_TASK_FIXTURE_MODE ?? argMode;
const record = process.env.LINGXI_TASK_FIXTURE_RECORD ?? argRecord;
if (record) appendFileSync(record, `${JSON.stringify({ pid: process.pid })}\n`);
const emit = (value) => console.log(JSON.stringify(value));
const complete = () => {
  emit({
    method: 'item/started',
    params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution' } },
  });
  emit({
    method: 'item/agentMessage/delta',
    params: { threadId: 'another-thread', delta: 'SHOULD_NOT_APPEAR', itemId: 'wrong' },
  });
  emit({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: '本轮' },
  });
  emit({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: '已完成' },
  });
  emit({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: mode === 'failed' ? 'failed' : 'completed' },
    },
  });
};
let config;
async function browser(prompt) {
  const endpoint = config.mcp_servers.lingxi_preview.url;
  const call = async (argumentsValue, expectedError = false) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LINGXI_PREVIEW_MCP_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'preview', arguments: argumentsValue },
      }),
    });
    const { result } = await response.json();
    if (expectedError) {
      if (!result.isError) throw new Error('Expected stale binding rejection');
      return;
    }
    if (result.isError) throw new Error('MCP failed');
    return JSON.parse(result.content[0].text);
  };
  if (prompt.includes('stale')) {
    const previous = JSON.parse(readFileSync(`${record}.binding.json`, 'utf8'));
    await call({ ...previous, requestId: randomUUID() }, true);
    return;
  }
  const snapshot = await call({ action: 'snapshot' });
  const ref = snapshot.text.match(/(r\d+) button 金山/)[1];
  const action = {
    action: 'click',
    binding: snapshot.binding,
    ref,
    requestId: randomUUID(),
  };
  if (record) writeFileSync(`${record}.binding.json`, JSON.stringify(action));
  await call(action);
  await call(action); // A delivery retry must not vote twice.
  if (prompt.includes('type')) {
    const fresh = await call({ action: 'snapshot' });
    const input = fresh.text.match(/(r\d+) input 备注/)[1];
    await call({
      action: 'type',
      binding: fresh.binding,
      ref: input,
      text: '周末出发',
      requestId: '20985b93-b6e6-4741-8c5b-c218999a75c5',
    });
  }
}
createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (record) appendFileSync(record, `${line}\n`);
  if (message.method === 'initialize') {
    if (mode !== 'hang') emit({ id: 0, result: {} });
  } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    config = message.params.config;
    if (mode === 'rpc-error') emit({ id: 1, error: { message: 'PRIVATE ERROR' } });
    else emit({ id: 1, result: { thread: { id: 'thread-1' } } });
  } else if (message.method === 'turn/start') {
    emit({ id: 2, result: { turn: { id: 'turn-1' } } });
    if (mode === 'approval' || mode === 'file')
      emit({
        id: 70,
        method:
          mode === 'file'
            ? 'item/fileChange/requestApproval'
            : 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          command: 'echo hello',
          cwd: process.cwd(),
          reason: 'test approval',
        },
      });
    else if (mode === 'question')
      emit({
        id: 70,
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          questions: [{ id: 'color', question: '什么颜色？' }],
        },
      });
    else if (mode === 'wait') return;
    else if (mode === 'browser') {
      try {
        await browser(message.params.input[0].text);
        complete();
      } catch {
        emit({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed' } },
        });
      }
    } else complete();
  } else if (message.id === 70 && message.result) complete();
  else if (message.method === 'turn/interrupt')
    emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
    });
});
