#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
// Deterministic App Server peer. No model/provider login, real Codex or cloud calls.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [argMode, argRecord] = process.argv.slice(2);
const mode = process.env.LINGXI_TASK_FIXTURE_MODE ?? argMode;
const record = process.env.LINGXI_TASK_FIXTURE_RECORD ?? argRecord;
if (record) appendFileSync(record, `${JSON.stringify({ pid: process.pid, cwd: process.cwd() })}\n`);
const emit = (value) => console.log(JSON.stringify(value));
let currentThread = 'thread-1',
  currentTurn = 'turn-1',
  turnSequence = 0,
  threadSequence = 0;
let terminalRequest;
let lateUsage;
const usage = (tokens, window = 128000, threadId = currentThread, turnId = currentTurn) => ({
  method: 'thread/tokenUsage/updated',
  params: {
    threadId,
    turnId,
    tokenUsage: {
      modelContextWindow: window,
      last: {
        totalTokens: tokens,
        inputTokens: Math.max(0, tokens - 2000),
        cachedInputTokens: 12000,
        cacheWriteInputTokens: 1000,
        outputTokens: 2000,
        reasoningOutputTokens: 800,
      },
      total: {
        totalTokens: 150000,
        inputTokens: 140000,
        cachedInputTokens: 50000,
        cacheWriteInputTokens: 3000,
        outputTokens: 10000,
        reasoningOutputTokens: 3000,
      },
    },
  },
});
const complete = () => {
  const roundUsage = (total) => {
    const event = usage(120);
    const input = (total * 5) / 6;
    event.params.tokenUsage.last = {
      totalTokens: 120,
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 10,
    };
    event.params.tokenUsage.total = {
      totalTokens: total,
      inputTokens: input,
      outputTokens: total - input,
      cachedInputTokens: input <= 200 ? input / 2 : 100 + (input - 200) * 0.4,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: total / 12,
    };
    return event;
  };
  const measure =
    mode.startsWith('turn-usage') && !(mode === 'turn-usage-missing' && turnSequence === 1);
  if (measure) emit(roundUsage(turnSequence * 240 - 120));
  if (mode === 'telemetry') emit(usage(64000));
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
  if (measure) {
    const final = roundUsage(turnSequence * 240);
    if (mode === 'turn-usage-late' && turnSequence === 1) lateUsage = final;
    else {
      emit(final);
      emit(final); // Duplicate notifications cannot double-count a request.
      if (mode === 'turn-usage-reset') emit(roundUsage(120));
    }
  } else if (!mode.startsWith('turn-usage'))
    emit(usage(32000, mode === 'usage-unknown' ? null : 128000));
  if (lateUsage && turnSequence > 1) {
    emit(lateUsage); // Arrives after the newer turn's final report.
    lateUsage = undefined;
  }
  if (mode === 'telemetry') {
    emit(usage(96000, 128000, 'foreign-thread'));
    emit(usage(96000, 128000, currentThread, 'old-turn'));
    emit(usage(-1));
  }
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
    else
      emit({
        id: message.id,
        result: { thread: { id: currentThread }, model: 'test-model', reasoningEffort: 'medium' },
      });
  } else if (message.method === 'thread/fork') {
    currentThread = `fork-${++threadSequence}`;
    emit({
      id: message.id,
      result: { thread: { id: currentThread }, model: 'test-model', reasoningEffort: 'medium' },
    });
  } else if (message.method === 'collaborationMode/list') {
    if (mode === 'no-modes') emit({ id: message.id, error: { message: 'Unsupported' } });
    else
      emit({
        id: message.id,
        result: {
          data: [
            ...(mode === 'default-only' ? [] : [{ name: 'Plan', mode: 'plan' }]),
            { name: 'Default', mode: 'default' },
          ],
        },
      });
  } else if (message.method === 'config/requirements/read') {
    emit({
      id: message.id,
      result: {
        requirements:
          mode === 'restricted'
            ? {
                allowedApprovalPolicies: ['on-request'],
                allowedApprovalsReviewers: ['user'],
                allowedSandboxModes: ['workspace-write'],
              }
            : null,
      },
    });
  } else if (message.method === 'thread/settings/update') {
    if (mode === 'settings-error')
      emit({ id: message.id, error: { message: 'PRIVATE SETTINGS ERROR' } });
    else {
      emit({ id: message.id, result: {} });
      emit({
        method: 'thread/settings/updated',
        params: {
          threadId: message.params.threadId,
          threadSettings: {
            ...message.params,
            model: message.params.collaborationMode.settings.model,
            effort: message.params.collaborationMode.settings.reasoning_effort,
            ...(mode === 'settings-mismatch' ? { approvalsReviewer: 'wrong-reviewer' } : {}),
          },
        },
      });
    }
  } else if (message.method === 'turn/start') {
    currentThread = message.params.threadId;
    currentTurn = `turn-${++turnSequence}`;
    emit({ id: message.id, result: { turn: { id: currentTurn } } });
    emit({
      method: 'thread/settings/updated',
      params: {
        threadId: currentThread,
        threadSettings: {
          model: message.params.model ?? 'test-model',
          effort: message.params.effort ?? 'medium',
        },
      },
    });
    if (message.params.approvalsReviewer === 'auto_review') {
      for (const status of ['inProgress', mode === 'review-denied' ? 'denied' : 'approved'])
        emit({
          method: `item/autoApprovalReview/${status === 'inProgress' ? 'started' : 'completed'}`,
          params: {
            threadId: currentThread,
            turnId: currentTurn,
            reviewId: 'review-1',
            review: { status },
          },
        });
    }
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
        ? { data: [{ name: 'second_page_tools', pluginId: 'fixture-plugin' }], nextCursor: null }
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
  } else if (message.method === 'model/list') {
    if (mode === 'model-error') {
      emit({ id: message.id, error: { message: 'PRIVATE MODEL ERROR' } });
      return;
    }
    const first = {
      id: 'test',
      model: 'test-model',
      displayName: 'Test Model',
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'medium', description: 'Balanced' },
        { reasoningEffort: 'high', description: 'High' },
      ],
    };
    const second = {
      id: 'fast',
      model: 'fast-model',
      displayName: 'Fast Model',
      isDefault: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }],
    };
    emit({
      id: message.id,
      result: message.params.cursor
        ? {
            data: [second, { ...second, model: 'hidden-model', hidden: true }],
            nextCursor: mode === 'model-cycle' ? 'cycle' : null,
          }
        : { data: [first], nextCursor: mode === 'model-cycle' ? 'cycle' : 'models2' },
    });
  } else if (message.method === 'skills/list') emit({ id: message.id, result: { data: [] } });
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
