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
  expect(new WakePreferences(path, true).read().enabled).toBe(true);
  prefs.save(false);
  expect(new WakePreferences(path).read()).toMatchObject({ enabled: false, source: 'user' });
  expect(JSON.parse(await readFile(path, 'utf8')).enabled).toBe(false);
});
it('requires one decision for a legacy installation without a recorded user choice', async () => {
  const path = await file(),
    prefs = new WakePreferences(path, true);
  expect(prefs.read()).toMatchObject({ enabled: false, source: 'legacy-review' });
  prefs.save(true);
  expect(new WakePreferences(path, true).read()).toMatchObject({ enabled: true, source: 'user' });
});
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
