import { randomUUID } from 'node:crypto';
import { type ErrorCode, type Session, type SubmitCommand, sessionSchema } from '@lingxi/protocol';
import Database from 'better-sqlite3';

export class StoreConflict extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
  }
}

export class SessionStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL)',
    );
    const initial: Session = {
      schemaVersion: 1,
      id: randomUUID(),
      revision: 0,
      commands: [],
      artifact: null,
      integrations: { codex: 'not-configured', lingxi: 'not-configured' },
    };
    this.db
      .prepare('INSERT OR IGNORE INTO session (id, value) VALUES (1, ?)')
      .run(JSON.stringify(initial));
    this.read();
  }

  read(): Session {
    const row = this.db.prepare('SELECT value FROM session WHERE id = 1').get() as {
      value: string;
    };
    return sessionSchema.parse(JSON.parse(row.value));
  }

  submit(input: SubmitCommand): { snapshot: Session; replayed: boolean } {
    return this.db
      .transaction(() => {
        const snapshot = this.read();
        const existing = snapshot.commands.find((command) => command.id === input.commandId);
        if (existing) {
          const signature = (value: {
            source: string;
            text: string;
            selection?: SubmitCommand['selection'];
          }) => JSON.stringify([value.source, value.text, value.selection ?? null]);
          if (signature(existing) !== signature(input))
            throw new StoreConflict('command_id_conflict');
          return { snapshot, replayed: true };
        }
        if (input.expectedRevision !== snapshot.revision)
          throw new StoreConflict('revision_conflict');
        if (
          input.selection &&
          (input.selection.artifactId !== snapshot.artifact?.id ||
            input.selection.artifactRevision !== snapshot.artifact?.revision)
        )
          throw new StoreConflict('selection_stale');
        snapshot.commands.push({
          id: input.commandId,
          source: input.source,
          text: input.text,
          status: 'draft',
          createdAt: new Date().toISOString(),
          ...(input.selection ? { selection: input.selection } : {}),
        });
        snapshot.revision += 1;
        this.db.prepare('UPDATE session SET value = ? WHERE id = 1').run(JSON.stringify(snapshot));
        return { snapshot, replayed: false };
      })
      .immediate();
  }

  close(): void {
    this.db.close();
  }
}
