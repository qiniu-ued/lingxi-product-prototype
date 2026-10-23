import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubmitCommand } from '@lingxi/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from './store.js';

const stores: SessionStore[] = [];
const directories: string[] = [];
function open(path = ':memory:') {
  const store = new SessionStore(path);
  stores.push(store);
  return store;
}
const command = (expectedRevision = 0): SubmitCommand => ({
  commandId: randomUUID(),
  source: 'keyboard',
  text: '把标题改成周末计划',
  expectedRevision,
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('durable shared session', () => {
  it('deduplicates retries even after the session revision has advanced', () => {
    const store = open();
    const input = command();
    store.submit(input);
    store.submit(command(1));
    const retry = store.submit(input);
    expect(retry.replayed).toBe(true);
    expect(retry.snapshot.commands).toHaveLength(2);
    expect(retry.snapshot.revision).toBe(2);
  });
  it('rejects reused command IDs with changed content', () => {
    const store = open();
    const input = command();
    store.submit(input);
    expect(() => store.submit({ ...input, text: '另一条修改' })).toThrow('command_id_conflict');
  });
  it('prevents a stale participant from overwriting newer discussion', () => {
    const store = open();
    store.submit(command());
    expect(() => store.submit(command())).toThrow('revision_conflict');
    expect(store.read().commands).toHaveLength(1);
  });
  it('restores session and drafts after closing and reopening the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lingxi-store-'));
    directories.push(directory);
    const path = join(directory, 'room.db');
    const first = new SessionStore(path);
    const snapshot = first.submit(command()).snapshot;
    first.close();
    expect(open(path).read()).toEqual(snapshot);
  });
  it('serializes independent database connections with the same revision', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lingxi-concurrency-'));
    directories.push(directory);
    const path = join(directory, 'room.db');
    const first = open(path);
    const second = open(path);
    first.submit(command());
    expect(() => second.submit(command())).toThrow('revision_conflict');
    expect(second.read()).toEqual(first.read());
  });
  it('rejects selections for missing artifacts rather than guessing a target', () => {
    const store = open();
    expect(() =>
      store.submit({
        ...command(),
        source: 'pointer',
        selection: {
          artifactId: randomUUID(),
          artifactRevision: 0,
          elementId: 'hero',
          label: '主标题',
        },
      }),
    ).toThrow('selection_stale');
    expect(store.read().revision).toBe(0);
  });
});
