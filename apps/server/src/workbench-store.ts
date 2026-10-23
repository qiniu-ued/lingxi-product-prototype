import { taskSchema, type WorkbenchState, workbenchSchema } from '@lingxi/protocol';
import Database from 'better-sqlite3';

// Additive migration: existing v1 session rows remain byte-for-byte compatible.
// Old app versions ignore workbench_state; do not downgrade or delete this table.
export class WorkbenchStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS workbench_state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL)',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS workbench_requests (id TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    this.db.prepare('INSERT OR IGNORE INTO workbench_state (id, value) VALUES (1, ?)').run(
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        desktop: false,
        project: null,
        task: null,
        preview: null,
      }),
    );
  }
  read(): WorkbenchState {
    const row = this.db.prepare('SELECT value FROM workbench_state WHERE id = 1').get() as {
      value: string;
    };
    return workbenchSchema.parse(JSON.parse(row.value));
  }
  write(state: WorkbenchState) {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE workbench_state SET value = ? WHERE id = 1')
        .run(JSON.stringify(workbenchSchema.parse(state)));
      if (state.task)
        this.db
          .prepare(
            'INSERT INTO workbench_requests (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
          )
          .run(state.task.id, JSON.stringify(taskSchema.parse(state.task)));
    })();
  }
  request(id: string) {
    const row = this.db.prepare('SELECT value FROM workbench_requests WHERE id=?').get(id) as
      | { value: string }
      | undefined;
    return row ? taskSchema.parse(JSON.parse(row.value)) : null;
  }
  close() {
    this.db.close();
  }
}
