import { randomUUID } from 'node:crypto';
import {
  type PreviewSelection,
  type Project,
  previewBindingSchema,
  projectSchema,
  type Task,
  type TaskDecision,
  type WorkbenchState,
} from '@lingxi/protocol';
import { z } from 'zod';
import { runCodexSession } from './codex-session.js';
import type { CodexSetup } from './codex-setup.js';
import type { DesktopBridge } from './desktop-bridge.js';
import { WorkbenchStore } from './workbench-store.js';

const done = (task: Task | null) =>
  !task || ['completed', 'failed', 'interrupted'].includes(task.status);
const record = z.record(z.string(), z.unknown());
const threadResult = z.object({ thread: z.object({ id: z.string() }) });
const turnResult = z.object({ turn: z.object({ id: z.string(), status: z.string().optional() }) });

export class Workbench {
  private store: WorkbenchStore;
  private state: WorkbenchState;
  private listeners = new Set<(state: WorkbenchState) => void>();
  private controller: AbortController | undefined;
  private send: ((message: unknown) => void) | undefined;
  private pending: Promise<void> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private approvalRequest:
    | { id: string | number; key: string; method: string; questions: string[] }
    | undefined;
  private closed = false;
  private address = '';
  constructor(
    private options: {
      databasePath: string;
      codex: CodexSetup;
      desktop?: DesktopBridge;
      mcpToken: string;
      executable?: string;
      prefixArgs?: string[];
      timeoutMs?: number;
    },
  ) {
    this.store = new WorkbenchStore(options.databasePath);
    this.state = this.store.read();
    this.state.desktop = !!options.desktop;
    this.state.preview = null;
    if (!done(this.state.task) && this.state.task) {
      this.state.task.status = 'interrupted';
      this.state.task.approval = null;
      this.state.task.activity = '应用已重启，请核对项目中的实际修改后继续。';
    }
    this.store.write(this.state);
  }
  setAddress(address: string) {
    this.address = address;
  }
  read() {
    return this.state;
  }
  subscribe(listener: (state: WorkbenchState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private update(change: Partial<WorkbenchState> = {}) {
    this.state = { ...this.state, ...change, revision: this.state.revision + 1 };
    if (this.state.task) this.state.task.updatedAt = new Date().toISOString();
    this.store.write(this.state);
    for (const listener of this.listeners) listener(this.state);
  }
  private taskUpdate(patch: Partial<Task>) {
    if (this.state.task) this.update({ task: { ...this.state.task, ...patch } });
  }
  setProject(value: unknown) {
    if (!done(this.state.task) || this.pending) throw new Error('task_running');
    const project = projectSchema.parse(value);
    this.update({ project, task: null, preview: null });
  }
  setPreview(value: unknown) {
    const preview = value === null ? null : previewBindingSchema.parse(value);
    if (preview && preview.projectId !== this.state.project?.id) throw new Error('project_changed');
    this.update({ preview });
  }
  async publish() {
    if (!this.options.desktop || !this.state.project) throw new Error('desktop_required');
    const preview = await this.options.desktop.call('publish', this.state.project);
    this.setPreview(preview);
  }
  start(id: string, text: string, selection: PreviewSelection | null = null) {
    const project = this.state.project;
    if (!this.options.desktop || !project || this.closed) throw new Error('project_required');
    const prior = this.store.request(id);
    if (prior) {
      if (
        prior.prompt !== text ||
        prior.projectId !== project.id ||
        JSON.stringify(prior.selection) !== JSON.stringify(selection)
      )
        throw new Error('request_conflict');
      return this.state.task?.id === id ? this.state.task : prior;
    }
    if (this.state.task?.id === id) {
      if (
        this.state.task.prompt !== text ||
        this.state.task.projectId !== project.id ||
        JSON.stringify(this.state.task.selection) !== JSON.stringify(selection)
      )
        throw new Error('request_conflict');
      return this.state.task;
    }
    if (!done(this.state.task) || this.pending) throw new Error('task_running');
    if (selection && JSON.stringify(selection.binding) !== JSON.stringify(this.state.preview))
      throw new Error('selection_stale');
    const previousThread = this.state.task?.threadId;
    const task: Task = {
      id,
      projectId: project.id,
      prompt: text,
      selection,
      status: 'starting',
      threadId: previousThread ?? null,
      turnId: null,
      messages: [],
      activity: '正在启动 Codex…',
      approval: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.update({ task });
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.run(project, task, controller.signal).finally(() => {
      this.pending = undefined;
    });
    return task;
  }
  decide(input: TaskDecision) {
    const request = this.approvalRequest;
    if (
      !request ||
      !this.send ||
      this.state.task?.id !== input.taskId ||
      request.key !== input.approvalId
    )
      throw new Error('approval_stale');
    if (
      request.method === 'item/tool/requestUserInput' ||
      request.method === 'tool/requestUserInput'
    ) {
      if (input.decision === 'decline') {
        this.interrupt();
        return;
      }
      if (
        input.decision !== 'accept' ||
        request.questions.some((id) => !input.answers?.[id]?.trim())
      )
        throw new Error('answers_required');
      const answers = Object.fromEntries(
        request.questions.map((id) => [id, { answers: [input.answers?.[id]] }]),
      );
      this.send({ id: request.id, result: { answers } });
    } else this.send({ id: request.id, result: { decision: input.decision } });
    this.approvalRequest = undefined;
    this.taskUpdate({ status: 'running', approval: null, activity: 'Codex 正在继续…' });
  }
  interrupt() {
    const task = this.state.task;
    if (!task || done(task)) return;
    this.taskUpdate({ status: 'stopping', approval: null, activity: '正在停止当前任务…' });
    this.approvalRequest = undefined;
    if (this.send && task.threadId && task.turnId)
      this.send({
        id: 30,
        method: 'turn/interrupt',
        params: { threadId: task.threadId, turnId: task.turnId },
      });
    this.stopTimer ??= setTimeout(() => this.controller?.abort(), 2500);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.interrupt();
    await this.pending;
    clearTimeout(this.stopTimer);
    this.listeners.clear();
    this.store.close();
  }
  private async run(project: Project, task: Task, signal: AbortSignal) {
    try {
      const executable = this.options.executable ?? (await this.options.codex.executable());
      const config = {
        mcp_servers: {
          lingxi_preview: {
            url: `${this.address}/mcp/preview`,
            bearer_token_env_var: 'LINGXI_PREVIEW_MCP_TOKEN',
          },
        },
      };
      const developerInstructions = [
        'You are the coding and browser agent for the local Lingxi workbench.',
        'The user may ask to modify code OR to interact with the currently visible artifact. Use lingxi_preview tools for artifact interactions; they target the exact page on the shared display.',
        'For this initial static frontend runtime, write the public entry point at preview/index.html, with HTML, CSS and browser JavaScript. No dev server is required. Do not start background servers.',
        'Preserve existing browser localStorage when changing code. Do not claim tests passed unless you ran them.',
        'A code change is published after your turn completes. Ask the user to publish an existing artifact if no visible preview is bound.',
      ].join('\n');
      const outcome = await runCodexSession<string>({
        executable,
        prefixArgs: this.options.prefixArgs ?? [],
        cwd: project.path,
        env: { ...process.env, LINGXI_PREVIEW_MCP_TOKEN: this.options.mcpToken },
        timeoutMs: this.options.timeoutMs ?? 1_800_000,
        maxOutputBytes: 8 * 1024 * 1024,
        processGroup: true,
        signal,
        onReady: (send) => {
          this.send = send;
          send({
            id: 1,
            method: task.threadId ? 'thread/resume' : 'thread/start',
            params: {
              ...(task.threadId ? { threadId: task.threadId } : {}),
              cwd: project.path,
              approvalPolicy: 'on-request',
              sandbox: 'workspace-write',
              config,
              developerInstructions,
            },
          });
        },
        onMessage: (message, send, finish) => {
          if (this.state.task?.status === 'stopping') {
            finish('interrupted');
            return;
          }
          if (message.id === 1 && !message.method) {
            const threadId = threadResult.parse(message.result).thread.id;
            this.taskUpdate({ threadId, activity: '正在提交需求…' });
            send({
              id: 2,
              method: 'turn/start',
              params: {
                threadId,
                input: [
                  {
                    type: 'text',
                    text:
                      task.prompt +
                      (task.selection
                        ? `\nUser selected an element in the visible preview (re-check with MCP before acting): ${JSON.stringify(task.selection)}`
                        : ''),
                  },
                ],
              },
            });
            return;
          }
          if (message.id === 2 && !message.method) {
            this.taskUpdate({
              turnId: turnResult.parse(message.result).turn.id,
              status: 'running',
              activity: 'Codex 正在执行…',
            });
            return;
          }
          const params = record.safeParse(message.params);
          if (!params.success) return;
          const p = params.data;
          if (p.threadId && p.threadId !== this.state.task?.threadId) return;
          if (p.turnId && this.state.task?.turnId && p.turnId !== this.state.task.turnId) return;
          if (message.id !== undefined && message.method) {
            if (this.approvalRequest) {
              send({
                id: message.id,
                error: {
                  code: -32000,
                  message: 'Another approval is pending; retry after it is resolved.',
                },
              });
              return;
            }
            const key = randomUUID();
            if (
              message.method === 'item/commandExecution/requestApproval' ||
              message.method === 'item/fileChange/requestApproval'
            ) {
              this.approvalRequest = { id: message.id, key, method: message.method, questions: [] };
              this.taskUpdate({
                status: 'waiting',
                activity: '等待你批准操作',
                approval: {
                  id: key,
                  kind: message.method.includes('commandExecution') ? 'command' : 'file',
                  title: message.method.includes('commandExecution')
                    ? 'Codex 请求运行命令'
                    : 'Codex 请求修改文件',
                  detail: [p.command, p.cwd, p.reason]
                    .filter((v) => typeof v === 'string')
                    .join('\n')
                    .slice(0, 8000),
                },
              });
            } else if (
              message.method === 'item/tool/requestUserInput' ||
              message.method === 'tool/requestUserInput'
            ) {
              const questions = z
                .array(z.object({ id: z.string(), question: z.string() }))
                .parse(p.questions);
              this.approvalRequest = {
                id: message.id,
                key,
                method: message.method,
                questions: questions.map((q) => q.id),
              };
              this.taskUpdate({
                status: 'waiting',
                activity: 'Codex 需要补充信息',
                approval: {
                  id: key,
                  kind: 'question',
                  title: '补充信息后继续',
                  detail: '',
                  questions,
                },
              });
            } else if (message.method === 'item/permissions/requestApproval')
              send({ id: message.id, result: { permissions: {}, scope: 'turn' } });
            else
              send({
                id: message.id,
                error: { code: -32601, message: 'Unsupported request in Lingxi' },
              });
            return;
          }
          if (message.method === 'item/agentMessage/delta') {
            const id = z.string().parse(p.itemId),
              delta = z.string().parse(p.delta);
            const messages = [...(this.state.task?.messages ?? [])];
            const existing = messages.find((m) => m.id === id);
            if (existing) existing.text = (existing.text + delta).slice(-16000);
            else messages.push({ id, text: delta.slice(-16000) });
            this.taskUpdate({ messages: messages.slice(-30) });
          }
          if (message.method === 'item/completed') {
            const item = z
              .object({ type: z.string(), id: z.string(), text: z.string().optional() })
              .parse(p.item);
            if (item.type === 'agentMessage' && item.text) {
              const messages = (this.state.task?.messages ?? []).filter((m) => m.id !== item.id);
              messages.push({ id: item.id, text: item.text.slice(-16000) });
              this.taskUpdate({ messages: messages.slice(-30) });
            }
          }
          if (message.method === 'item/started') {
            const item = z.object({ type: z.string() }).parse(p.item);
            const label: Record<string, string> = {
              commandExecution: '正在运行命令',
              fileChange: '正在修改文件',
              mcpToolCall: '正在操作工具',
              webSearch: '正在查询资料',
              agentMessage: 'Codex 正在回复',
            };
            this.taskUpdate({ activity: label[item.type] ?? 'Codex 正在执行…' });
          }
          if (message.method === 'turn/completed') {
            const turn = z.object({ id: z.string(), status: z.string() }).parse(p.turn);
            if (this.state.task?.turnId && turn.id !== this.state.task.turnId) return;
            finish(turn.status);
          }
        },
      });
      clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
      this.send = undefined;
      this.approvalRequest = undefined;
      const status =
        outcome.status === 'ok'
          ? outcome.value
          : outcome.status === 'cancelled'
            ? 'interrupted'
            : 'failed';
      let activity = 'Codex 本轮执行结束';
      if (status === 'completed') {
        this.taskUpdate({ activity: '正在发布预览…' });
        try {
          await this.publish();
        } catch {
          activity = '本轮已结束，尚未生成可发布的 preview/index.html';
        }
      }
      this.taskUpdate({
        status:
          status === 'completed'
            ? 'completed'
            : status === 'interrupted'
              ? 'interrupted'
              : 'failed',
        approval: null,
        activity:
          status === 'completed'
            ? activity
            : status === 'interrupted'
              ? '任务已停止，已产生的文件修改仍保留'
              : '任务未完成，请检查 Codex 配置后重试',
        error:
          status !== 'completed' && status !== 'interrupted'
            ? 'Codex 执行失败或连接中断。未自动重试。'
            : null,
      });
    } catch {
      this.send = undefined;
      this.taskUpdate({
        status: signal.aborted ? 'interrupted' : 'failed',
        approval: null,
        activity: '未能完成本轮任务',
        error: '请在连接向导检查 Codex；文件修改不会自动回退。',
      });
    } finally {
      clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
      this.controller = undefined;
      this.send = undefined;
      this.approvalRequest = undefined;
    }
  }
}
