import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { WorkbenchStore } from './workbench-store.js';

it('imports v1 once, preserves legacy rows and keeps the normalized latest turn reachable by history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingxi-migration-')),
    path = join(root, 'db.sqlite');
  const db = new Database(path);
  let store: WorkbenchStore | undefined;
  try {
    const id = randomUUID(),
      projectId = randomUUID(),
      now = new Date().toISOString();
    const task = {
      id,
      projectId,
      prompt: 'legacy task',
      status: 'completed',
      threadId: 'thread-legacy',
      turnId: 'turn-legacy',
      messages: [{ id: 'reply', text: 'legacy answer' }],
      activity: 'done',
      approval: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const legacy = JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      desktop: true,
      project: { id: projectId, name: 'Legacy', path: root },
      task,
      preview: null,
    });
    const receipt = JSON.stringify(task);
    db.exec(
      'CREATE TABLE session(id INTEGER PRIMARY KEY,value TEXT); CREATE TABLE workbench_state(id INTEGER PRIMARY KEY,value TEXT); CREATE TABLE workbench_requests(id TEXT PRIMARY KEY,value TEXT)',
    );
    db.prepare('INSERT INTO session VALUES(1,?)').run('untouched-v1-session');
    db.prepare('INSERT INTO workbench_state VALUES(1,?)').run(legacy);
    db.prepare('INSERT INTO workbench_requests VALUES(?,?)').run(id, receipt);
    store = new WorkbenchStore(path);
    const state = store.read();
    expect(state.selectedThreadId).toBe(id);
    expect(store.history(id)[0]).toMatchObject({ id, selection: null, conversationId: id });
    state.revision = 5;
    store.write(state);
    store.close();
    store = undefined;
    expect(db.prepare('SELECT value FROM workbench_state').get()).toEqual({ value: legacy });
    expect(db.prepare('SELECT value FROM workbench_requests').get()).toEqual({ value: receipt });
    expect(db.prepare('SELECT value FROM session').get()).toEqual({
      value: 'untouched-v1-session',
    });
    db.prepare('UPDATE workbench_state SET value=?').run(
      legacy.replace('legacy task', 'downgraded app write'),
    );
    store = new WorkbenchStore(path);
    expect(store.read().revision).toBe(5);
    expect(store.request(id)?.prompt).toBe('legacy task');
  } finally {
    store?.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
