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
let currentThread = 'thread-1',
  currentTurn = 'turn-1',
  turnSequence = 0,
  threadSequence = 0;
let terminalRequest;
const complete = () => {
  emit({
    method: 'turn/diff/updated',
    params: {
      threadId: currentThread,
      turnId: currentTurn,
      diff: 'diff --git a/index.html b/index.html\n-old\n+new',
    },
  });
  emit({
    method: 'turn/plan/updated',
    params: {
      threadId: currentThread,
      turnId: currentTurn,
      plan: [{ step: '实现页面', status: 'completed' }],
    },
  });
  emit({
    method: 'item/started',
    params: {
      threadId: currentThread,
      turnId: currentTurn,
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'printf hello',
        aggregatedOutput: null,
        status: 'inProgress',
        pluginId: null,
        processId: null,
      },
    },
  });
  emit({
    method: 'item/agentMessage/delta',
    params: { threadId: 'another-thread', delta: 'SHOULD_NOT_APPEAR', itemId: 'wrong' },
  });
  emit({
    method: 'item/agentMessage/delta',
    params: { threadId: currentThread, turnId: currentTurn, itemId: 'message-1', delta: '本轮' },
  });
  emit({
    method: 'item/agentMessage/delta',
    params: { threadId: currentThread, turnId: currentTurn, itemId: 'message-1', delta: '已完成' },
  });
  emit({
    method: 'turn/completed',
    params: {
      threadId: currentThread,
      turn: { id: currentTurn, status: mode === 'failed' ? 'failed' : 'completed' },
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
    if (record)
      appendFileSync(
        record,
        `${JSON.stringify({ kind: 'mcp-result', action: argumentsValue.action, status: response.status, isError: result?.isError, text: result?.content?.[0]?.text })}\n`,
      );
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
    if (mode !== 'hang') emit({ id: message.id, result: {} });
  } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    config = message.params.config;
    currentThread = message.params.threadId ?? `thread-${++threadSequence}`;
    if (mode === 'rpc-error') emit({ id: message.id, error: { message: 'PRIVATE ERROR' } });
    else emit({ id: message.id, result: { thread: { id: currentThread } } });
  } else if (message.method === 'thread/fork') {
    currentThread = `fork-${++threadSequence}`;
    emit({ id: message.id, result: { thread: { id: currentThread } } });
  } else if (message.method === 'turn/start') {
    currentThread = message.params.threadId;
    currentTurn = `turn-${++turnSequence}`;
    emit({ id: message.id, result: { turn: { id: currentTurn } } });
    if (mode === 'approval' || mode === 'file')
      emit({
        id: 70,
        method:
          mode === 'file'
            ? 'item/fileChange/requestApproval'
            : 'item/commandExecution/requestApproval',
        params: {
          threadId: currentThread,
          turnId: currentTurn,
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
          threadId: currentThread,
          turnId: currentTurn,
          questions: [{ id: 'color', question: '什么颜色？' }],
        },
      });
    else if (
      mode === 'wait' ||
      mode === 'steer-timeout' ||
      (mode === 'rich' && message.params.input[0].text.includes('hold'))
    )
      return;
    else if (mode === 'rich' && message.params.input[0].text.includes('ask-many')) {
      for (const [id, color] of [
        [71, 'color'],
        [72, 'layout'],
      ])
        emit({
          id,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: currentThread,
            turnId: currentTurn,
            questions: [
              {
                id: color,
                header: '偏好',
                question: '请选择',
                isOther: true,
                isSecret: false,
                options: [
                  { label: '蓝色', description: '清爽' },
                  { label: '绿色', description: '自然' },
                ],
              },
            ],
          },
        });
    } else if (mode === 'browser') {
      try {
        await browser(message.params.input[0].text);
        complete();
      } catch {
        emit({
          method: 'turn/completed',
          params: { threadId: currentThread, turn: { id: currentTurn, status: 'failed' } },
        });
      }
    } else complete();
  } else if (message.method === 'mcpServerStatus/list')
    emit({
      id: message.id,
      result: message.params.cursor
        ? { data: [{ name: 'second_page_tools' }], nextCursor: null }
        : { data: [], nextCursor: 'page2' },
    });
  else if ((message.id === 71 || message.id === 72) && message.result) {
    emit({
      method: 'serverRequest/resolved',
      params: { threadId: currentThread, requestId: message.id },
    });
    if (message.id === 72) complete();
  } else if (message.method === 'turn/steer') {
    if (mode === 'steer-timeout') return;
    emit({ id: message.id, result: {} });
    if (message.params.input[0].text.includes('finish')) complete();
  } else if (message.method === 'command/exec') {
    terminalRequest = message;
    emit({
      method: 'command/exec/outputDelta',
      params: {
        processId: message.params.processId,
        stream: 'stdout',
        deltaBase64: Buffer.from('hello terminal\r\n').toString('base64'),
        capReached: false,
      },
    });
  } else if (message.method === 'command/exec/write' || message.method === 'command/exec/resize')
    emit({ id: message.id, result: {} });
  else if (message.method === 'command/exec/terminate') {
    emit({ id: message.id, result: {} });
    emit({ id: terminalRequest.id, result: { exitCode: 0, stdout: '', stderr: '' } });
  } else if (message.method === 'model/list')
    emit({
      id: message.id,
      result: {
        data: [
          {
            id: 'test',
            model: 'test-model',
            displayName: 'Test',
            supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
          },
        ],
      },
    });
  else if (message.method === 'skills/list') emit({ id: message.id, result: { data: [] } });
  else if (message.method === 'account/rateLimits/read')
    emit({ id: message.id, result: { rateLimits: null } });
  else if (message.method === 'fixture/out-of-order')
    setTimeout(() => emit({ id: message.id, result: message.params }), message.params.delay);
  else if (message.method === 'fixture/invalid') console.log('not-json');
  else if (message.method === 'fixture/error')
    emit({ id: message.id, error: { message: 'PRIVATE' } });
  else if (message.method === 'fixture/exit') process.exit(0);
  else if (message.method === 'fixture/hang') return;
  else if (message.id === 70 && message.result) complete();
  else if (message.method === 'turn/interrupt')
    emit({
      method: 'turn/completed',
      params: { threadId: currentThread, turn: { id: currentTurn, status: 'interrupted' } },
    });
});
