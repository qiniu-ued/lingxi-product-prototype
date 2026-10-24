import { taskSchema, type WorkbenchState, workbenchSchema } from '@lingxi/protocol';
import Database from 'better-sqlite3';

// v2 is additive and leaves the v1 snapshot/receipts intact for an old binary.
// On first open only, import the v1 latest task and receipts; never downgrade.
export class WorkbenchStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
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
        .run(JSON.stringify(state));
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
    return workbenchSchema.parse(JSON.parse(row.value));
  }
  write(state: WorkbenchState) {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE workspace_state_v2 SET value=? WHERE id=1')
        .run(JSON.stringify({ ...workbenchSchema.parse(state), terminal: null }));
      for (const task of state.history.concat(state.task ? [state.task] : []))
        this.db
          .prepare(
            'INSERT INTO workspace_turns_v2(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
          )
          .run(task.id, JSON.stringify(taskSchema.parse(task)));
    })();
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
