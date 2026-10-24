import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  codexAuthorizationUrlSchema,
  setupInspectionSchema,
  setupIssues,
  submitCommandSchema,
} from './index.js';

const input = () => ({
  commandId: randomUUID(),
  source: 'keyboard',
  text: '改大标题',
  expectedRevision: 0,
});

it('finds independent setup problems, preserves older inspection responses, and does not require prior microphone consent', () => {
  const checkedAt = new Date().toISOString();
  const ready = setupInspectionSchema.parse({
    environment: {
      checkedAt,
      host: { platform: 'darwin', arch: 'arm64', nodeVersion: '24.11.0', nodeSupported: true },
      capabilities: { codexTasks: true, lingxiVoice: true },
    },
    codex: { checkedAt, status: 'ready', cliVersion: '0.999.0', authentication: 'chatgpt' },
    lingxi: { checkedAt, status: 'configured', reason: 'configuration-saved' },
    wake: { checkedAt, status: 'ready', reason: 'model-ready' },
    microphone: 'not-determined',
  });
  expect(setupIssues(ready)).toEqual([]);
  expect(
    setupIssues({
      ...ready,
      codex: { ...ready.codex, status: 'signed-out' },
      lingxi: { ...ready.lingxi, status: 'not-configured' },
      wake: null,
      microphone: 'denied',
    }),
  ).toEqual(['codex', 'lingxi', 'wake', 'microphone']);
  expect(
    setupIssues({
      ...ready,
      environment: {
        ...ready.environment,
        host: { ...ready.environment.host, nodeSupported: false },
      },
    }),
  ).toEqual(['runtime']);
  const { wake: _wake, microphone: _microphone, ...legacy } = ready;
  expect(setupInspectionSchema.parse(legacy).wake).toBeNull();
  expect(setupIssues(setupInspectionSchema.parse(legacy))).toEqual(['wake']);
});

describe('command boundary', () => {
  it('limits login links to official HTTPS hosts without credentials or custom ports', () => {
    for (const value of [
      'not a url',
      'http://auth.openai.com/login',
      'https://auth.openai.com.attacker.example/',
      'https://user:secret@auth.openai.com/',
      'https://auth.openai.com:1234/',
      'javascript:alert(1)',
    ]) {
      expect(codexAuthorizationUrlSchema.safeParse(value).success).toBe(false);
    }
    for (const value of [
      'https://auth.openai.com/authorize?state=example',
      'https://chatgpt.com/authorize',
    ]) {
      expect(codexAuthorizationUrlSchema.safeParse(value).success).toBe(true);
    }
  });
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
