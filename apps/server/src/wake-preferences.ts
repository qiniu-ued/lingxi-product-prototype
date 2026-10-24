import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type WakePreference, wakePreferenceSchema } from '@lingxi/protocol';

// Non-secret, versioned user intent, independent of provider tokens and Task/v2.
export class WakePreferences {
  private value: WakePreference;
  constructor(private file: string | null) {
    this.value = { version: 1, enabled: true, source: 'default' };
    if (!file) return;
    try {
      const data = readFileSync(file, 'utf8');
      if (data.length > 2048) throw new Error('invalid_preference');
      const stored = wakePreferenceSchema
        .partial({ enabled: true, source: true })
        .parse(JSON.parse(data));
      this.value =
        stored.source === 'unavailable'
          ? { version: 1, enabled: false, source: 'unavailable' }
          : stored.source === 'legacy-review' || stored.enabled === undefined
            ? { version: 1, enabled: true, source: 'default' }
            : { version: 1, enabled: stored.enabled, source: stored.source ?? 'user' };
      if (stored.enabled !== this.value.enabled || stored.source !== this.value.source)
        this.persist(this.value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          this.persist(this.value);
        } catch {
          this.unavailable();
        }
      } else this.unavailable();
    }
  }
  read() {
    return { ...this.value };
  }
  private unavailable() {
    this.value = { version: 1, enabled: false, source: 'unavailable' };
  }
  private persist(value: WakePreference) {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const staging = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(staging, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      renameSync(staging, this.file);
    } finally {
      rmSync(staging, { force: true });
    }
  }
  save(enabled: boolean) {
    const value: WakePreference = { version: 1, enabled, source: 'user' };
    try {
      this.persist(value);
      this.value = value;
    } catch {
      this.unavailable();
      throw new Error('wake_preference_unavailable');
    }
    return this.read();
  }
}
