import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WakePreferences } from './wake-preferences.js';

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function file() {
  const root = await mkdtemp(join(tmpdir(), 'lingxi-wake-preference-'));
  roots.push(root);
  return join(root, 'wake-preferences.v1.json');
}
it('defaults a fresh installation on and preserves an explicit off across restarts', async () => {
  const path = await file(),
    prefs = new WakePreferences(path);
  expect(prefs.read()).toMatchObject({ enabled: true, source: 'default' });
  expect(new WakePreferences(path).read().enabled).toBe(true);
  prefs.save(false);
  expect(new WakePreferences(path).read()).toMatchObject({ enabled: false, source: 'user' });
  expect(JSON.parse(await readFile(path, 'utf8')).enabled).toBe(false);
});
it.each(['wake-preferences.v1.json', 'voice-connection-preferences.v1.json'])(
  'migrates missing choices and known legacy defaults on for %s, preserving explicit false',
  async (name) => {
    const path = join(await file(), '..', name);
    for (const stored of [
      { version: 1 },
      { version: 1, source: 'user' },
      { version: 1, enabled: false, source: 'legacy-review' },
    ]) {
      await writeFile(path, JSON.stringify(stored));
      expect(new WakePreferences(path).read()).toEqual({
        version: 1,
        enabled: true,
        source: 'default',
      });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        version: 1,
        enabled: true,
        source: 'default',
      });
    }
    for (const stored of [
      { version: 1, enabled: false },
      { version: 1, enabled: false, source: 'user' },
      { version: 1, enabled: false, source: 'default' },
    ]) {
      await writeFile(path, JSON.stringify(stored));
      expect(new WakePreferences(path).read().enabled).toBe(false);
      expect(new WakePreferences(path).read().enabled).toBe(false);
    }
  },
);
it('disables ambiguous or corrupt preferences until the user replaces them', async () => {
  const path = await file();
  await writeFile(path, '{PRIVATE_INVALID');
  const prefs = new WakePreferences(path);
  expect(prefs.read()).toMatchObject({ enabled: false, source: 'unavailable' });
  expect(JSON.stringify(prefs.read())).not.toContain('PRIVATE');
  prefs.save(true);
  expect(new WakePreferences(path).read().enabled).toBe(true);
});
it('never enables automatic listening when intent cannot be stored', async () => {
  const path = await file();
  await writeFile(path, 'occupied');
  const prefs = new WakePreferences(join(path, 'prefs'));
  expect(prefs.read()).toMatchObject({ enabled: false, source: 'unavailable' });
  expect(() => prefs.save(true)).toThrow('wake_preference_unavailable');
  expect(prefs.read().enabled).toBe(false);
});
