import { createHash, randomUUID } from 'node:crypto';
import {
  type ContextAttachment,
  type Conversation,
  modelDescriptorSchema,
  type PreviewSelection,
  type Project,
  previewBindingSchema,
  projectSchema,
  type Task,
  type TaskDecision,
  type TerminalCommand,
  type ThreadRuntime,
  threadTokenUsageSchema,
  type WorkbenchState,
  type WorkspaceCommand,
} from '@lingxi/protocol';
import { z } from 'zod';
import { CodexClient, type RpcMessage } from './codex-client.js';
import type { CodexSetup } from './codex-setup.js';
import type { DesktopBridge } from './desktop-bridge.js';
import { WorkbenchStore } from './workbench-store.js';

const done = (task: Task | null) =>
  !task || ['completed', 'failed', 'interrupted'].includes(task.status);
const record = z.record(z.string(), z.unknown());
const threadResult = z.object({
  thread: z.object({
    id: z.string(),
    model: z.string().nullable().optional(),
    reasoningEffort: z.string().nullable().optional(),
  }),
  model: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
});
const turnResult = z.object({ turn: z.object({ id: z.string(), status: z.string().optional() }) });
const questionsSchema = z.array(
  z.object({
    id: z.string(),
    question: z.string(),
    header: z.string().optional(),
    isOther: z.boolean().optional(),
    isSecret: z.boolean().optional(),
    options: z
      .array(z.object({ label: z.string(), description: z.string() }))
      .nullable()
      .optional(),
  }),
);

export class Workbench {
  private store: WorkbenchStore;
  private state: WorkbenchState;
  private listeners = new Set<(state: WorkbenchState) => void>();
  private client: CodexClient | undefined;
  private connecting: Promise<CodexClient> | undefined;
  private loaded = new Set<string>();
  private readonlyPlugins = new Map<string, string[]>();
  private discoveredPlugins: string[] = [];
  private turnEvents: RpcMessage[] = [];
  private turnEventBytes = 0;
  private pending: Promise<void> | undefined;
  private publishing = false;
  private stagedVoice: {
    target: string;
    at: number;
    selection: PreviewSelection | null;
    attachments: ContextAttachment[];
  } | null = null;
  private publication: Promise<void> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private turnTimer: ReturnType<typeof setTimeout> | undefined;
  private requests = new Map<
    string,
    { id: string | number; taskId: string; method: string; questions: string[] }
  >();
  private closed = false;
  private switching = false;
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
    this.state.terminal = null;
    const recover = (task: Task) => {
      if (!done(task))
        return {
          ...task,
          status: 'interrupted' as const,
          approval: null,
          approvals: [],
          activity: '应用已重启，请核对项目中的实际修改后继续。',
        };
      return task;
    };
    this.state.history = this.state.history.map(recover);
    if (this.state.task) this.state.task = recover(this.state.task);
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
    this.store.write(this.state);
    for (const listener of this.listeners) listener(this.state);
  }
  private taskUpdate(patch: Partial<Task>) {
    if (!this.state.task) return;
    const task = { ...this.state.task, ...patch, updatedAt: new Date().toISOString() };
    this.update({ task, history: this.state.history.map((t) => (t.id === task.id ? task : t)) });
  }
  private ensureIdle() {
    if (!done(this.state.task) || this.pending || this.publishing || this.switching)
      throw new Error('task_running');
  }
  setProject(value: unknown) {
    this.ensureIdle();
    const project = projectSchema.parse(value);
    const old = this.client;
    this.client = undefined;
    this.connecting = undefined;
    this.loaded.clear();
    this.readonlyPlugins.clear();
    // Closing the old connection also terminates its PTYs. Never replay them.
    if (old) void this.disposeClient(old, this.state.terminal?.id);
    const selected = this.state.threads.find(
      (t) => t.projectId === project.id && !t.archived && t.kind !== 'sidechat',
    );
    const history = selected ? this.store.history(selected.id) : [];
    this.update({
      project,
      task: history.at(-1) ?? null,
      history,
      selectedThreadId: selected?.id ?? null,
      preview: null,
      terminal: null,
      runtime: selected?.codexId ? this.runtimeFor(selected) : null,
    });
  }
  setPreview(value: unknown) {
    const preview = value === null ? null : previewBindingSchema.parse(value);
    if (preview && preview.projectId !== this.state.project?.id) throw new Error('project_changed');
    if (JSON.stringify(this.state.preview) !== JSON.stringify(preview)) this.update({ preview });
  }
  async publish() {
    if (!this.options.desktop || !this.state.project) throw new Error('desktop_required');
    this.setPreview(await this.options.desktop.call('publish', this.state.project));
  }
  async connectPreview(url: string) {
    if (!this.options.desktop || !this.state.project) throw new Error('project_required');
    const value = new URL(url);
    if (value.origin === this.address || value.port === new URL(this.address).port)
      throw new Error('invalid_project_url');
    this.setPreview(
      await this.options.desktop.call('preview-connect', { project: this.state.project, url }),
    );
  }
  setVoiceContext(input: {
    projectId: string;
    conversationId: string | null;
    selection: PreviewSelection | null;
    attachments: ContextAttachment[];
    text: string;
  }) {
    if (
      !this.options.desktop ||
      input.projectId !== this.state.project?.id ||
      input.conversationId !== this.state.selectedThreadId
    )
      throw new Error('project_changed');
    if (input.text && input.attachments.length >= 20) throw new Error('context_limit');
    const attachments = input.text
      ? [
          ...input.attachments,
          { id: randomUUID(), kind: 'text' as const, title: '键盘草稿', text: input.text },
        ]
      : input.attachments;
    this.stagedVoice = {
      target: JSON.stringify([input.projectId, input.conversationId]),
      at: Date.now(),
      selection: input.selection,
      attachments,
    };
  }
  voiceContext() {
    const value = this.stagedVoice;
    this.stagedVoice = null;
    if (!value) return { selection: null, attachments: [] };
    if (
      Date.now() - value.at > 15000 ||
      value.target !== JSON.stringify([this.state.project?.id, this.state.selectedThreadId])
    )
      throw new Error('voice_context_changed');
    return { selection: value.selection, attachments: value.attachments };
  }
  private conversation() {
    const thread = this.state.threads.find((t) => t.id === this.state.selectedThreadId);
    if (!thread) throw new Error('thread_required');
    return thread;
  }
  private newConversation(
    title: string,
    kind: Conversation['kind'] = 'main',
    parentId: string | null = null,
    codexId: string | null = null,
  ) {
    if (!this.state.project) throw new Error('project_required');
    const thread: Conversation = {
      id: randomUUID(),
      projectId: this.state.project.id,
      codexId,
      title,
      kind,
      parentId,
      archived: false,
      createdAt: new Date().toISOString(),
    };
    this.update({
      threads: [...this.state.threads, thread],
      selectedThreadId: thread.id,
      task: null,
      history: [],
      runtime: null,
    });
    return thread;
  }
  start(
    id: string,
    text: string,
    selection: PreviewSelection | null = null,
    attachments: ContextAttachment[] = [],
    mode: 'start' | 'queue' | 'steer' = 'start',
  ) {
    const project = this.state.project;
    if (!this.options.desktop || !project || this.closed || this.switching)
      throw new Error('project_required');
    if (this.store.input(id)) throw new Error('request_conflict');
    const prior = this.store.request(id);
    if (prior) {
      if (
        prior.prompt !== text ||
        prior.projectId !== project.id ||
        JSON.stringify(prior.selection) !== JSON.stringify(selection) ||
        JSON.stringify(prior.attachments ?? []) !== JSON.stringify(attachments)
      )
        throw new Error('request_conflict');
      return prior;
    }
    if (mode === 'steer') throw new Error('use_steer');
    if (selection && JSON.stringify(selection.binding) !== JSON.stringify(this.state.preview))
      throw new Error('selection_stale');
    if (
      attachments.some(
        (a) =>
          a.selection && JSON.stringify(a.selection.binding) !== JSON.stringify(this.state.preview),
      )
    )
      throw new Error('selection_stale');
    if (!done(this.state.task) || this.pending || this.publishing) {
      if (mode !== 'queue') throw new Error('task_running');
    }
    const conversation = this.state.selectedThreadId
      ? this.conversation()
      : this.newConversation(text.slice(0, 80));
    const queued = !done(this.state.task) || !!this.pending || this.publishing;
    const task: Task = {
      id,
      projectId: project.id,
      prompt: text,
      selection,
      attachments,
      conversationId: conversation.id,
      settings: { ...this.state.settings },
      status: queued ? 'queued' : 'starting',
      threadId: conversation.codexId,
      turnId: null,
      messages: [],
      items: [],
      plan: [],
      approvals: [],
      additions: [],
      diff: '',
      activity: queued ? '等待上一轮结束' : '正在启动 Codex…',
      approval: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.update({ history: [...this.state.history, task], ...(queued ? {} : { task }) });
    if (!queued) this.launch(project, task);
    return task;
  }
  private launch(project: Project, task: Task) {
    this.turnEvents = [];
    this.turnEventBytes = 0;
    this.pending = this.run(project, task).finally(() => {
      this.pending = undefined;
      if (done(this.state.task)) this.nextQueued();
    });
  }
  private nextQueued() {
    if (
      this.closed ||
      this.pending ||
      this.publishing ||
      !done(this.state.task) ||
      !this.state.project
    )
      return;
    const next = this.state.history.find((t) => t.status === 'queued');
    if (next) {
      this.update({ task: next });
      this.taskUpdate({ status: 'starting', activity: '正在提交排队指令…' });
      this.launch(this.state.project, this.state.task as Task);
    }
  }
  private async connection() {
    if (this.client) {
      await this.client.ready;
      return this.client;
    }
    if (!this.state.project || this.closed) throw new Error('project_required');
    this.connecting ??= (async () => {
      const executable = this.options.executable ?? (await this.options.codex.executable());
      const client = new CodexClient({
        executable,
        prefixArgs: this.options.prefixArgs ?? [],
        cwd: (this.state.project as Project).path,
        env: { ...process.env, LINGXI_PREVIEW_MCP_TOKEN: this.options.mcpToken },
        timeoutMs: this.options.timeoutMs ?? 15000,
        onMessage: (message) => {
          if (this.client === client) this.onMessage(message);
        },
        onDisconnect: () => {
          if (this.client !== client) return;
          this.client = undefined;
          this.connecting = undefined;
          this.loaded.clear();
          this.readonlyPlugins.clear();
          if (this.state.terminal)
            this.update({ terminal: { ...this.state.terminal, status: 'failed' } });
          if (!done(this.state.task)) this.finish('failed');
        },
      });
      this.client = client;
      try {
        await client.ready;
        return client;
      } catch (error) {
        await client.close();
        throw error;
      }
    })();
    return this.connecting;
  }
  private async config(readonly: boolean, client: CodexClient) {
    const config: Record<string, unknown> = {
      mcp_servers: {
        lingxi_preview: {
          url: `${this.address}/mcp/preview`,
          bearer_token_env_var: 'LINGXI_PREVIEW_MCP_TOKEN',
        },
      },
    };
    if (readonly) {
      // Sidechat must not inherit mutating MCP tools. Fail closed if discovery
      // fails, rather than assuming a read-only filesystem makes MCP safe.
      const names = new Set(['lingxi_preview']);
      const plugins = new Set<string>();
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = z
          .object({
            data: z.array(
              z.object({ name: z.string(), pluginId: z.string().nullable().optional() }),
            ),
            nextCursor: z.string().nullable().optional(),
          })
          .parse(
            await client.request('mcpServerStatus/list', {
              limit: 100,
              ...(cursor ? { cursor } : {}),
            }),
          );
        for (const server of page.data) {
          names.add(server.name);
          if (server.pluginId) plugins.add(server.pluginId);
        }
        cursor = page.nextCursor ?? null;
        if (cursor && (seen.has(cursor) || names.size > 1000))
          throw new Error('mcp_discovery_incomplete');
        if (cursor) seen.add(cursor);
      } while (cursor);
      this.discoveredPlugins = [...plugins];
      for (const name of names) {
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('unsupported_mcp_name');
        config[`mcp_servers.${name}.enabled`] = false;
      }
    }
    return config;
  }
  private instructions(readonly: boolean) {
    return [
      'You are the coding and browser agent for the local Lingxi workbench.',
      readonly
        ? 'This is a read-only side discussion. Explain and research the supplied context. Do not modify files, run mutating commands, use network tools, or operate the preview.'
        : 'The user may ask to modify code OR interact with the visible product. Use lingxi_preview for interactions; it operates the exact shared display page.',
      'For a simple static project use preview/index.html. For an existing framework project preserve its architecture. The user can launch its development server in the integrated terminal and bind a loopback URL in the UI.',
      'Preserve browser localStorage. Report only tests and operations actually performed. Publishing a static preview is attempted after the turn.',
    ].join('\n');
  }
  private async run(project: Project, task: Task) {
    try {
      const client = await this.connection();
      if (this.state.task?.status === 'stopping') {
        this.finish('interrupted');
        return;
      }
      const thread = this.conversation();
      if (!this.loaded.has(thread.id)) {
        const readonly = thread.kind === 'sidechat';
        const result = threadResult.parse(
          await client.request(thread.codexId ? 'thread/resume' : 'thread/start', {
            ...(thread.codexId ? { threadId: thread.codexId } : {}),
            cwd: project.path,
            approvalPolicy: readonly ? 'never' : 'on-request',
            sandbox: readonly ? 'read-only' : 'workspace-write',
            config: await this.config(readonly, client),
            developerInstructions: this.instructions(readonly),
          }),
        );
        thread.codexId = result.thread.id;
        this.confirmConfiguration(
          thread,
          result.model ?? result.thread.model,
          result.reasoningEffort !== undefined
            ? result.reasoningEffort
            : result.thread.reasoningEffort,
        );
        this.loaded.add(thread.id);
        if (readonly) this.readonlyPlugins.set(thread.id, [...this.discoveredPlugins]);
        this.update({
          threads: this.state.threads.map((t) => (t.id === thread.id ? { ...thread } : t)),
        });
      }
      this.taskUpdate({ threadId: thread.codexId, activity: '正在提交需求…' });
      this.turnTimer = setTimeout(() => {
        this.interrupt();
      }, this.options.timeoutMs ?? 1_800_000);
      const input = this.input(task.prompt, task.selection, task.attachments ?? []);
      const settings = task.settings ?? this.state.settings;
      const result = turnResult.parse(
        await client.request('turn/start', {
          threadId: thread.codexId,
          ...(thread.kind === 'sidechat'
            ? { disabledPluginIds: this.readonlyPlugins.get(thread.id) ?? [] }
            : {}),
          clientUserMessageId: task.id,
          input,
          ...(settings.model ? { model: settings.model } : {}),
          ...(settings.effort ? { effort: settings.effort } : {}),
          ...(settings.plan
            ? {
                input: this.input(
                  `先制定计划并向我确认，再实施。\n${task.prompt}`,
                  task.selection,
                  task.attachments ?? [],
                ),
              }
            : {}),
        }),
      );
      if (this.state.task?.id !== task.id || done(this.state.task)) return;
      const stopping = this.read().task?.status === 'stopping';
      this.taskUpdate({
        turnId: result.turn.id,
        status: stopping ? 'stopping' : this.requests.size ? 'waiting' : 'running',
        activity: stopping ? '正在停止当前任务…' : 'Codex 正在执行…',
      });
      const events = this.turnEvents;
      this.turnEvents = [];
      this.turnEventBytes = 0;
      for (const event of events) this.onMessage(event);
      if (stopping && !done(this.state.task)) this.interrupt();
    } catch {
      this.finish('failed');
    }
  }
  private input(
    text: string,
    selection: PreviewSelection | null,
    attachments: ContextAttachment[],
  ) {
    return [
      {
        type: 'text',
        text:
          text +
          (selection
            ? `\nUser selected visible preview element (re-check with MCP): ${JSON.stringify(selection)}`
            : '') +
          attachments
            .map(
              (a) =>
                `\n<user_context kind=${JSON.stringify(a.kind)} title=${JSON.stringify(a.title)}>\n${a.text}${a.selection ? `\nPreview target: ${JSON.stringify(a.selection)}` : ''}\n</user_context>`,
            )
            .join(''),
        text_elements: [],
      },
    ];
  }
  async steer(
    id: string,
    text: string,
    selection: PreviewSelection | null,
    attachments: ContextAttachment[],
  ) {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ text, selection, attachments }))
      .digest('hex');
    const prior = this.store.input(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('request_conflict');
      if (prior.status === 'acknowledged') return;
      throw new Error('steer_unconfirmed');
    }
    if (this.store.request(id)) throw new Error('request_conflict');
    const task = this.state.task;
    if (!task?.turnId || !task.threadId || done(task) || task.status !== 'running' || !this.client)
      throw new Error('turn_unavailable');
    if (
      (selection && JSON.stringify(selection.binding) !== JSON.stringify(this.state.preview)) ||
      attachments.some(
        (a) =>
          a.selection && JSON.stringify(a.selection.binding) !== JSON.stringify(this.state.preview),
      )
    )
      throw new Error('selection_stale');
    // Reserve durably before dispatch. An uncertain RPC response must never
    // cause the same supplemental instruction to be sent twice, even on restart.
    this.taskUpdate({
      additions: [...(task.additions ?? []), { id, text, fingerprint, status: 'pending' }],
    });
    const complete = (status: 'acknowledged' | 'unconfirmed') => {
      const latest = this.state.history.find((t) => t.id === task.id);
      if (!latest) return;
      const additions = (latest.additions ?? []).map((a) => (a.id === id ? { ...a, status } : a));
      if (this.state.task?.id === task.id) this.taskUpdate({ additions });
      else
        this.update({
          history: this.state.history.map((t) => (t.id === task.id ? { ...t, additions } : t)),
        });
    };
    try {
      await this.client.request('turn/steer', {
        threadId: task.threadId,
        expectedTurnId: task.turnId,
        clientUserMessageId: id,
        input: this.input(text, selection, attachments),
      });
      complete('acknowledged');
    } catch (error) {
      complete('unconfirmed');
      throw error;
    }
  }
  decide(input: TaskDecision) {
    const request = this.requests.get(input.approvalId);
    if (
      !request ||
      !this.client ||
      request.taskId !== input.taskId ||
      this.state.task?.id !== input.taskId
    )
      throw new Error('approval_stale');
    if (request.questions.length) {
      if (input.decision === 'decline') {
        this.interrupt();
        return;
      }
      if (request.questions.some((id) => !input.answers?.[id]?.trim()))
        throw new Error('answers_required');
      const answers = Object.fromEntries(
        request.questions.map((id) => [id, { answers: [input.answers?.[id]] }]),
      );
      this.client.respond(request.id, { answers });
    } else this.client.respond(request.id, { decision: input.decision });
    this.requests.delete(input.approvalId);
    const approvals = (this.state.task.approvals ?? []).filter((a) => a.id !== input.approvalId);
    this.taskUpdate({
      status: approvals.length ? 'waiting' : 'running',
      approvals,
      approval: approvals[0] ?? null,
      activity: approvals.length ? '等待其余问题或批准' : 'Codex 正在继续…',
    });
  }
  interrupt() {
    const task = this.state.task;
    if (!task || done(task)) return;
    this.taskUpdate({
      status: 'stopping',
      approval: null,
      approvals: [],
      activity: '正在停止当前任务…',
    });
    this.requests.clear();
    if (this.client && task.threadId && task.turnId)
      void this.client
        .request('turn/interrupt', { threadId: task.threadId, turnId: task.turnId })
        .catch(() => {});
    this.stopTimer ??= setTimeout(() => {
      // An unresponsive turn requires closing the shared connection. PTYs are
      // explicitly marked failed by disconnect; no background process leaks.
      if (this.client) void this.client.close();
      this.finish('interrupted');
    }, 2500);
  }
  private finish(value: string) {
    const task = this.state.task;
    if (!task || done(task)) return;
    clearTimeout(this.turnTimer);
    this.turnTimer = undefined;
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    this.requests.clear();
    const status =
      task.status === 'stopping' || value === 'interrupted'
        ? 'interrupted'
        : value === 'completed'
          ? 'completed'
          : 'failed';
    if (status !== 'completed')
      this.update({
        history: this.state.history.map((t) =>
          t.status === 'queued'
            ? {
                ...t,
                status: 'interrupted',
                activity: '上一轮未完成，排队已暂停；核对修改后重新提交。',
              }
            : t,
        ),
      });
    this.taskUpdate({
      status,
      approval: null,
      approvals: [],
      activity:
        status === 'completed'
          ? 'Codex 本轮执行结束'
          : status === 'interrupted'
            ? '任务已停止，已产生的文件修改仍保留'
            : 'Codex 连接中断或执行失败，未自动重试',
      error: status === 'failed' ? '请检查连接向导，核对项目修改后重试。' : null,
    });
    const id = task.id;
    const readonly =
      this.state.threads.find((t) => t.id === task.conversationId)?.kind === 'sidechat';
    this.publishing =
      status === 'completed' && !readonly && !this.state.preview?.url.startsWith('http:');
    const publish = this.publishing
      ? this.publish().catch(() => {
          if (this.state.task?.id === id)
            this.taskUpdate({
              activity: '本轮已结束，尚未生成可发布的 preview/index.html；可连接项目开发服务器。',
            });
        })
      : Promise.resolve();
    this.publication = publish.finally(() => {
      this.publishing = false;
      this.nextQueued();
    });
  }
  private runtimeFor(thread: Conversation): ThreadRuntime {
    const stored = this.store.runtime(thread.id);
    if (stored?.codexId === thread.codexId) return stored;
    return {
      conversationId: thread.id,
      codexId: thread.codexId as string,
      model: null,
      effort: null,
      configurationUpdatedAt: null,
      usage: null,
      usageTurnId: null,
      usageUpdatedAt: null,
    };
  }
  private saveRuntime(value: ThreadRuntime) {
    this.store.writeRuntime(value);
    if (value.conversationId === this.state.selectedThreadId) this.update({ runtime: value });
  }
  private confirmConfiguration(
    thread: Conversation,
    model?: string | null,
    effort?: string | null,
  ) {
    if (!thread.codexId || (model === undefined && effort === undefined)) return;
    const value = this.runtimeFor(thread);
    this.saveRuntime({
      ...value,
      model: model === undefined ? value.model : model,
      effort: effort === undefined ? value.effort : effort,
      configurationUpdatedAt: new Date().toISOString(),
    });
  }
  private bufferEvent(message: RpcMessage) {
    this.turnEventBytes += Buffer.byteLength(JSON.stringify(message));
    if (this.turnEventBytes > 8 * 1024 * 1024) throw new Error('turn_event_limit');
    this.turnEvents.push(message);
  }
  private onMessage(message: RpcMessage) {
    const parsed = record.safeParse(message.params);
    if (!parsed.success) return;
    const p = parsed.data;
    if (message.method === 'command/exec/outputDelta') {
      const event = z
        .object({ processId: z.string(), deltaBase64: z.string().max(2_000_000) })
        .parse(p);
      const terminal = this.state.terminal;
      if (terminal?.id === event.processId) {
        const seq = terminal.seq + 1;
        this.update({
          terminal: {
            ...terminal,
            status: 'running',
            seq,
            chunks: [...terminal.chunks, { seq, data: event.deltaBase64 }].slice(-200),
          },
        });
      }
      return;
    }
    if (
      message.method === 'thread/tokenUsage/updated' ||
      message.method === 'thread/settings/updated'
    ) {
      const thread = this.state.threads.find(
        (t) => t.codexId === p.threadId && t.projectId === this.state.project?.id,
      );
      if (!thread) return;
      if (message.method === 'thread/settings/updated') {
        const settings = z
          .object({ model: z.string(), effort: z.string().nullable() })
          .safeParse(p.threadSettings);
        if (settings.success)
          this.confirmConfiguration(thread, settings.data.model, settings.data.effort);
      } else {
        const event = z
          .object({ turnId: z.string(), tokenUsage: threadTokenUsageSchema })
          .safeParse(p);
        if (!event.success) return;
        const task =
          this.state.task?.conversationId === thread.id
            ? this.state.task
            : this.store.history(thread.id).findLast((t) => t.turnId);
        if (task && !task.turnId && ['starting', 'stopping'].includes(task.status)) {
          this.bufferEvent(message);
          return;
        }
        if (task?.turnId && task.turnId !== event.data.turnId) return;
        this.saveRuntime({
          ...this.runtimeFor(thread),
          usage: event.data.tokenUsage,
          usageTurnId: event.data.turnId,
          usageUpdatedAt: new Date().toISOString(),
        });
      }
      return;
    }
    const task = this.state.task;
    if (!task || done(task)) return;
    if (
      (p.threadId && p.threadId !== task.threadId) ||
      (p.turnId && task.turnId && p.turnId !== task.turnId)
    )
      return;
    // Notifications can arrive in the same stdout frame as the turn/start
    // response, before its Promise continuation runs. Buffer until the actual
    // turn id is known; never lose a fast completion or accept an old turn.
    if (!task.turnId && ['starting', 'stopping'].includes(task.status)) {
      this.bufferEvent(message);
      return;
    }
    if (message.id !== undefined && message.method) {
      if (this.conversation().kind === 'sidechat') {
        this.client?.reject(message.id);
        return;
      }
      const key = randomUUID();
      if (
        message.method === 'item/commandExecution/requestApproval' ||
        message.method === 'item/fileChange/requestApproval'
      ) {
        this.requests.set(key, {
          id: message.id,
          taskId: task.id,
          method: message.method,
          questions: [],
        });
        const approval = {
          id: key,
          kind: message.method.includes('commandExecution')
            ? ('command' as const)
            : ('file' as const),
          title: message.method.includes('commandExecution')
            ? 'Codex 请求运行命令'
            : 'Codex 请求修改文件',
          detail: [p.command, p.cwd, p.reason]
            .filter((v) => typeof v === 'string')
            .join('\n')
            .slice(0, 8000),
        };
        const approvals = [...(task.approvals ?? []), approval];
        this.taskUpdate({
          status: 'waiting',
          activity: '等待你批准操作',
          approvals,
          approval: approvals[0] ?? null,
        });
      } else if (
        message.method === 'item/tool/requestUserInput' ||
        message.method === 'tool/requestUserInput'
      ) {
        const questions = questionsSchema.parse(p.questions);
        this.requests.set(key, {
          id: message.id,
          taskId: task.id,
          method: message.method,
          questions: questions.map((q) => q.id),
        });
        const approvals = [
          ...(task.approvals ?? []),
          { id: key, kind: 'question' as const, title: '补充信息后继续', detail: '', questions },
        ];
        this.taskUpdate({
          status: 'waiting',
          activity: 'Codex 需要补充信息',
          approvals,
          approval: approvals[0] ?? null,
        });
      } else if (message.method === 'item/permissions/requestApproval')
        this.client?.respond(message.id, { permissions: {}, scope: 'turn' });
      else this.client?.reject(message.id);
      return;
    }
    if (
      message.method === 'serverRequest/resolved' ||
      message.method === 'serverRequest/received'
    ) {
      if (message.method.endsWith('resolved')) {
        for (const [key, request] of this.requests)
          if (request.id === p.requestId) this.requests.delete(key);
        const approvals = (task.approvals ?? []).filter((a) => this.requests.has(a.id));
        this.taskUpdate({
          approvals,
          approval: approvals[0] ?? null,
          status: approvals.length ? 'waiting' : 'running',
        });
      }
    }
    if (message.method === 'item/agentMessage/delta') {
      const id = z.string().parse(p.itemId),
        delta = z.string().parse(p.delta);
      const messages = task.messages.map((m) => ({ ...m }));
      const existing = messages.find((m) => m.id === id);
      if (existing) existing.text += delta;
      else messages.push({ id, text: delta });
      this.taskUpdate({ messages });
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = z.object({ type: z.string(), id: z.string() }).passthrough().parse(p.item);
      if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text)
        this.taskUpdate({
          messages: [
            ...task.messages.filter((m) => m.id !== item.id),
            { id: item.id, text: item.text },
          ],
        });
      // ThreadItem is a union. Fields such as aggregatedOutput are explicitly
      // nullable on a started command; unrelated item variants can omit them.
      const text =
        (typeof item.text === 'string'
          ? item.text
          : [item.command, item.aggregatedOutput]
              .filter((value) => typeof value === 'string')
              .join('\n')) || JSON.stringify(item);
      const items = (this.state.task?.items ?? []).filter((i) => i.id !== item.id);
      items.push({
        id: item.id,
        type: item.type,
        text: text.slice(0, 64000),
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
      });
      this.taskUpdate({
        items,
        activity: message.method === 'item/started' ? `正在执行 · ${item.type}` : 'Codex 正在继续…',
      });
    }
    if (message.method === 'turn/diff/updated') this.taskUpdate({ diff: z.string().parse(p.diff) });
    if (message.method === 'turn/plan/updated')
      this.taskUpdate({
        plan: z.array(z.object({ step: z.string(), status: z.string() })).parse(p.plan),
      });
    if (message.method === 'turn/completed') {
      const turn = z.object({ id: z.string(), status: z.string() }).parse(p.turn);
      if (!task.turnId || task.turnId === turn.id) this.finish(turn.status);
    }
  }
  async command(command: WorkspaceCommand) {
    if (!this.state.project || !this.options.desktop) throw new Error('project_required');
    if (command.action === 'settings') {
      this.update({ settings: command.settings });
      return;
    }
    if (command.action === 'cancel-queued') {
      const task = this.state.history.find((t) => t.id === command.id && t.status === 'queued');
      if (!task) throw new Error('queue_stale');
      this.update({
        history: this.state.history.map((t) =>
          t.id === task.id ? { ...task, status: 'interrupted', activity: '已取消排队' } : t,
        ),
      });
      return;
    }
    this.ensureIdle();
    if (command.action === 'new-thread') {
      this.newConversation(command.title);
      return;
    }
    if (command.action === 'fork') {
      const task = this.store.request(command.taskId);
      if (
        !task?.threadId ||
        !task.turnId ||
        !done(task) ||
        task.projectId !== this.state.project.id
      )
        throw new Error('fork_unavailable');
      const client = await this.connection();
      this.switching = true;
      try {
        const readonly = command.kind === 'sidechat';
        // A conversation fork shares the working directory. The UI states this
        // explicitly; it is never represented as an isolated code worktree.
        const result = threadResult.parse(
          await client.request('thread/fork', {
            threadId: task.threadId,
            lastTurnId: task.turnId,
            cwd: this.state.project.path,
            sandbox: readonly ? 'read-only' : 'workspace-write',
            approvalPolicy: readonly ? 'never' : 'on-request',
            config: await this.config(readonly, client),
            developerInstructions: this.instructions(readonly),
          }),
        );
        const thread = this.newConversation(
          `${readonly ? 'Sidechat' : 'Fork'} · ${task.prompt.slice(0, 60)}`,
          command.kind,
          task.conversationId ?? null,
          result.thread.id,
        );
        this.confirmConfiguration(
          thread,
          result.model ?? result.thread.model,
          result.reasoningEffort !== undefined
            ? result.reasoningEffort
            : result.thread.reasoningEffort,
        );
        this.loaded.add(thread.id);
        if (readonly) this.readonlyPlugins.set(thread.id, [...this.discoveredPlugins]);
      } finally {
        this.switching = false;
      }
      return;
    }
    const thread = this.state.threads.find(
      (t) => t.id === command.id && t.projectId === this.state.project?.id,
    );
    if (!thread) throw new Error('thread_unavailable');
    if (command.action === 'select-thread') {
      const history = this.store.history(thread.id);
      this.update({
        selectedThreadId: thread.id,
        history,
        task: history.at(-1) ?? null,
        runtime: thread.codexId ? this.runtimeFor(thread) : null,
      });
    } else if (command.action === 'rename-thread')
      this.update({
        threads: this.state.threads.map((t) =>
          t.id === thread.id ? { ...t, title: command.title } : t,
        ),
      });
    else
      this.update({
        threads: this.state.threads.map((t) =>
          t.id === thread.id ? { ...t, archived: command.archived } : t,
        ),
      });
  }
  async terminal(command: TerminalCommand) {
    if (!this.options.desktop || !this.state.project || this.switching)
      throw new Error('project_required');
    if (this.state.selectedThreadId && this.conversation().kind === 'sidechat')
      throw new Error('readonly_sidechat');
    const client = await this.connection();
    if (command.action === 'open') {
      const previous = this.state.terminal;
      if (previous?.id === command.requestId) return;
      if (previous && ['starting', 'running'].includes(previous.status))
        throw new Error('terminal_running');
      const id = command.requestId;
      this.update({
        terminal: {
          id,
          projectId: this.state.project.id,
          status: 'starting',
          chunks: [],
          seq: 0,
          exitCode: null,
        },
      });
      // This is the user's intentional terminal. The executable is selected by
      // the application, never by a model/device/HTTP executable parameter.
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh';
      const commandArgs = process.platform === 'darwin' ? [shell, '-l'] : ['/bin/bash', '-l'];
      void client
        .request(
          'command/exec',
          {
            command: commandArgs,
            processId: id,
            tty: true,
            streamStdin: true,
            streamStdoutStderr: true,
            disableTimeout: true,
            outputBytesCap: 2_000_000,
            cwd: this.state.project.path,
            size: { rows: 20, cols: 100 },
            sandboxPolicy: {
              type: 'workspaceWrite',
              writableRoots: [this.state.project.path],
              networkAccess: true,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
          },
          null,
        )
        .then((result) => {
          const value = z.object({ exitCode: z.number() }).parse(result);
          if (this.state.terminal?.id === id)
            this.update({
              terminal: { ...this.state.terminal, status: 'exited', exitCode: value.exitCode },
            });
        })
        .catch(() => {
          if (this.state.terminal?.id === id)
            this.update({ terminal: { ...this.state.terminal, status: 'failed' } });
        });
      return;
    }
    if (
      this.state.terminal?.id !== command.id ||
      !['starting', 'running'].includes(this.state.terminal.status)
    )
      throw new Error('terminal_stale');
    if (command.action === 'write')
      await client.request('command/exec/write', {
        processId: command.id,
        deltaBase64: Buffer.from(command.data).toString('base64'),
      });
    else if (command.action === 'resize')
      await client.request('command/exec/resize', {
        processId: command.id,
        size: { rows: command.rows, cols: command.cols },
      });
    else await client.request('command/exec/terminate', { processId: command.id });
  }
  async models() {
    if (!this.options.desktop || !this.state.project) throw new Error('project_required');
    const projectId = this.state.project.id,
      client = await this.connection();
    const data = new Map<string, z.infer<typeof modelDescriptorSchema>>(),
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = z
        .object({
          data: z.array(modelDescriptorSchema),
          nextCursor: z.string().nullable().optional(),
        })
        .parse(
          await client.request('model/list', {
            includeHidden: false,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        );
      if (this.state.project?.id !== projectId) throw new Error('project_changed');
      for (const model of page.data) if (!model.hidden) data.set(model.model, model);
      cursor = page.nextCursor ?? null;
      if (data.size > 500 || seen.size >= 10 || (cursor && seen.has(cursor)))
        throw new Error('model_catalog_limit');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { projectId, data: [...data.values()] };
  }
  async catalog() {
    if (!this.options.desktop || !this.state.project) throw new Error('project_required');
    const client = await this.connection();
    const results = await Promise.allSettled([
      this.models(),
      client.request('skills/list', { cwds: [this.state.project.path] }),
      client.request('mcpServerStatus/list', {}),
      client.request('account/rateLimits/read', {}),
    ]);
    // Allowlisted informational methods only. Do not return provider config or
    // account tokens. Each failed capability remains independently unavailable.
    return Object.fromEntries(
      ['models', 'skills', 'mcp', 'limits'].map((name, i) => [
        name,
        results[i]?.status === 'fulfilled' ? results[i].value : null,
      ]),
    );
  }
  private async disposeClient(client: CodexClient, terminalId?: string) {
    if (terminalId)
      await client
        .request('command/exec/terminate', { processId: terminalId }, 750)
        .catch(() => {});
    await client.close();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.turnTimer);
    clearTimeout(this.stopTimer);
    this.finish('interrupted');
    const client = this.client;
    this.client = undefined;
    if (client) await this.disposeClient(client, this.state.terminal?.id);
    await this.pending;
    await this.publication;
    this.listeners.clear();
    this.store.close();
  }
}
