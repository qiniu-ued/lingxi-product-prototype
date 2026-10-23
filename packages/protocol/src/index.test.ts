import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { submitCommandSchema } from './index.js';

const input = () => ({
  commandId: randomUUID(),
  source: 'keyboard',
  text: '改大标题',
  expectedRevision: 0,
});

describe('command boundary', () => {
  it('rejects interim or unknown fields instead of accidentally submitting speech', () => {
    expect(submitCommandSchema.safeParse({ ...input(), partial: true }).success).toBe(false);
    expect(submitCommandSchema.safeParse({ ...input(), source: 'transcript' }).success).toBe(false);
  });
  it('rejects blank, oversized, and unversioned input', () => {
    for (const patch of [{ text: '  ' }, { text: 'a'.repeat(4001) }, { expectedRevision: -1 }]) {
      expect(submitCommandSchema.safeParse({ ...input(), ...patch }).success).toBe(false);
    }
  });
  it('requires a target for pointer input and preserves target revision', () => {
    expect(submitCommandSchema.safeParse({ ...input(), source: 'pointer' }).success).toBe(false);
    const selection = {
      artifactId: randomUUID(),
      artifactRevision: 7,
      elementId: 'hero',
      label: '主标题',
    };
    expect(
      submitCommandSchema.parse({ ...input(), source: 'pointer', selection }).selection,
    ).toEqual(selection);
  });
});
