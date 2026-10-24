import {
  type ThreadRuntime,
  taskSchema,
  threadRuntimeSchema,
  type WorkbenchState,
  workbenchSchema,
} from '@lingxi/protocol';
import Database from 'better-sqlite3';

function legacySnapshot(state: WorkbenchState) {
  const { runtime: _runtime, ...snapshot } = workbenchSchema.parse(state);
  return { ...snapshot, terminal: null };
}

// Runtime metadata uses a separate table so older v2 readers keep their strict schema.
// v2 is additive and leaves the v1 snapshot/receipts intact for an old binary.
// On first open only, import the v1 latest task and receipts; never downgrade.
export class WorkbenchStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_thread_runtime_v1 (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_requests (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_state_v2 (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_turns_v2 (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.db.transaction(() => {
      const exists = this.db.prepare('SELECT id FROM workspace_state_v2 WHERE id=1').get();
      if (exists) return;
      const old = this.db.prepare('SELECT value FROM workbench_state WHERE id=1').get() as
        | { value: string }
        | undefined;
      const state = workbenchSchema.parse(
        old
          ? JSON.parse(old.value)
          : {
              schemaVersion: 1,
              revision: 0,
              desktop: false,
              project: null,
              task: null,
              preview: null,
            },
      );
      // schemaVersion=1 remains the HTTP compatibility envelope. The table name
      // records the storage version; old apps cannot overwrite the v2 snapshot.
      if (state.task) {
        const projectId = state.task.projectId;
        const id = state.task.conversationId ?? state.task.id;
        state.threads = [
          {
            id,
            projectId,
            codexId: state.task.threadId,
            title: state.task.prompt.slice(0, 80),
            kind: 'main',
            parentId: null,
            archived: false,
            createdAt: state.task.createdAt,
          },
        ];
        state.selectedThreadId = id;
        state.task.conversationId = id;
        state.history = [state.task];
      }
      this.db
        .prepare('INSERT INTO workspace_state_v2(id,value) VALUES(1,?)')
        .run(JSON.stringify(legacySnapshot(state)));
      this.db.exec(
        'INSERT OR IGNORE INTO workspace_turns_v2(id,value) SELECT id,value FROM workbench_requests',
      );
      if (state.task)
        this.db
          .prepare(
            'INSERT INTO workspace_turns_v2(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
          )
          .run(state.task.id, JSON.stringify(state.task));
    })();
  }
  read(): WorkbenchState {
    const row = this.db.prepare('SELECT value FROM workspace_state_v2 WHERE id=1').get() as {
      value: string;
    };
    const state = workbenchSchema.parse(JSON.parse(row.value));
    const selected = state.threads.find((thread) => thread.id === state.selectedThreadId);
    const runtime = selected ? this.runtime(selected.id) : null;
    return { ...state, runtime: runtime && runtime.codexId === selected?.codexId ? runtime : null };
  }
  write(state: WorkbenchState) {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE workspace_state_v2 SET value=? WHERE id=1')
        .run(JSON.stringify(legacySnapshot(state)));
      for (const task of state.history.concat(state.task ? [state.task] : []))
        this.db
          .prepare(
            'INSERT INTO workspace_turns_v2(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
          )
          .run(task.id, JSON.stringify(taskSchema.parse(task)));
    })();
  }
  runtime(conversationId: string): ThreadRuntime | null {
    const row = this.db
      .prepare('SELECT value FROM workspace_thread_runtime_v1 WHERE id=?')
      .get(conversationId) as { value: string } | undefined;
    return row ? threadRuntimeSchema.parse(JSON.parse(row.value)) : null;
  }
  writeRuntime(value: ThreadRuntime) {
    const runtime = threadRuntimeSchema.parse(value);
    this.db
      .prepare(
        'INSERT INTO workspace_thread_runtime_v1(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(runtime.conversationId, JSON.stringify(runtime));
  }
  request(id: string) {
    const row = this.db.prepare('SELECT value FROM workspace_turns_v2 WHERE id=?').get(id) as
      | { value: string }
      | undefined;
    return row ? taskSchema.parse(JSON.parse(row.value)) : null;
  }
  input(id: string) {
    const row = this.db
      .prepare(
        "SELECT json_each.value AS value FROM workspace_turns_v2, json_each(workspace_turns_v2.value,'$.additions') WHERE json_extract(json_each.value,'$.id')=? LIMIT 1",
      )
      .get(id) as { value: string } | undefined;
    return row
      ? (JSON.parse(row.value) as NonNullable<
          ReturnType<typeof taskSchema.parse>['additions']
        >[number])
      : null;
  }
  history(conversationId: string) {
    const rows = this.db
      .prepare(
        "SELECT value FROM workspace_turns_v2 WHERE json_extract(value,'$.conversationId')=? ORDER BY json_extract(value,'$.createdAt'),rowid",
      )
      .all(conversationId) as { value: string }[];
    return rows.map((row) => taskSchema.parse(JSON.parse(row.value)));
  }
  close() {
    this.db.close();
  }
}
