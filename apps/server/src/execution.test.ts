import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CodexClient } from './codex-client.js';
import { applyExecution, executionParams } from './execution.js';

let root: string, project: string, extra: string, unexpected: string, alias: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lingxi-execution-confirm-'));
  project = join(root, 'project');
  extra = join(root, 'extra');
  unexpected = join(root, 'unexpected');
  alias = join(root, 'project-alias');
  for (const path of [project, extra, unexpected]) mkdirSync(path);
  symlinkSync(project, alias, 'dir');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function request(mode: 'plan' | 'default' = 'default') {
  return executionParams(
    'thread-1',
    { id: 'project-1', name: 'Test', path: project },
    'manual',
    false,
    mode,
    'test-model',
    'medium',
  );
}
type Confirmation = Omit<ReturnType<typeof request>, 'sandboxPolicy'> & {
  sandboxPolicy: Record<string, unknown>;
};
async function confirm(params: ReturnType<typeof request>, value: unknown) {
  const client = {
    async updateSettings(...[, accept]: Parameters<CodexClient['updateSettings']>) {
      if (!accept(value)) throw new Error('execution_unconfirmed');
    },
  } as CodexClient;
  await applyExecution(client, params);
}
function snapshot(params: ReturnType<typeof request>): Confirmation {
  return structuredClone(params);
}

it.each(['default', 'plan'] as const)('accepts the implicit cwd root in %s mode', async (mode) => {
  const params = request(mode);
  const event = snapshot(params);
  event.sandboxPolicy.writableRoots = [];
  await expect(confirm(params, event)).resolves.toBeUndefined();
});
it('accepts an explicit cwd, aliases, duplicate roots and root order without changing access', async () => {
  const params = request();
  params.sandboxPolicy.writableRoots = [project, extra];
  const event = snapshot(params);
  await expect(confirm(params, event)).resolves.toBeUndefined();
  event.cwd = alias;
  event.sandboxPolicy.writableRoots = [extra, alias, extra];
  await expect(confirm(params, event)).resolves.toBeUndefined();
  event.sandboxPolicy.writableRoots = [extra];
  await expect(confirm(params, event)).resolves.toBeUndefined();
});

const mismatches: Array<[string, (value: Confirmation) => void]> = [
  [
    'additional writable root',
    (v) => {
      v.sandboxPolicy.writableRoots = [unexpected];
    },
  ],
  [
    'wrong cwd even with unchanged roots',
    (v) => {
      v.cwd = unexpected;
    },
  ],
  [
    'relative cwd',
    (v) => {
      v.cwd = '.';
    },
  ],
  [
    'missing cwd',
    (v) => {
      Reflect.deleteProperty(v, 'cwd');
    },
  ],
  [
    'nonexistent cwd',
    (v) => {
      v.cwd = join(root, 'missing');
    },
  ],
  [
    'nonexistent writable root',
    (v) => {
      v.sandboxPolicy.writableRoots = [join(root, 'missing')];
    },
  ],
  [
    'relative writable root',
    (v) => {
      v.sandboxPolicy.writableRoots = ['.'];
    },
  ],
  [
    'missing roots',
    (v) => {
      delete v.sandboxPolicy.writableRoots;
    },
  ],
  [
    'malformed roots',
    (v) => {
      v.sandboxPolicy.writableRoots = [null];
    },
  ],
  [
    'wrong sandbox type',
    (v) => {
      v.sandboxPolicy.type = 'dangerFullAccess';
    },
  ],
  [
    'network enabled',
    (v) => {
      v.sandboxPolicy.networkAccess = true;
    },
  ],
  [
    'missing network setting',
    (v) => {
      delete v.sandboxPolicy.networkAccess;
    },
  ],
  [
    'changed tmpdir setting',
    (v) => {
      v.sandboxPolicy.excludeTmpdirEnvVar = true;
    },
  ],
  [
    'changed slash tmp setting',
    (v) => {
      v.sandboxPolicy.excludeSlashTmp = true;
    },
  ],
  [
    'wrong approval policy',
    (v) => {
      v.approvalPolicy = 'never';
    },
  ],
  [
    'wrong reviewer',
    (v) => {
      v.approvalsReviewer = 'auto_review';
    },
  ],
  [
    'wrong mode',
    (v) => {
      v.collaborationMode.mode = 'plan';
    },
  ],
  [
    'wrong model',
    (v) => {
      v.collaborationMode.settings.model = 'other-model';
    },
  ],
  [
    'wrong reasoning effort',
    (v) => {
      v.collaborationMode.settings.reasoning_effort = 'high';
    },
  ],
];
it.each(mismatches)('rejects %s before a turn can be submitted', async (_label, change) => {
  const params = request();
  const event = snapshot(params);
  change(event);
  await expect(confirm(params, event)).rejects.toThrow('execution_unconfirmed');
});
it('does not treat a missing requested non-cwd directory as implicit', async () => {
  const params = request();
  params.sandboxPolicy.writableRoots = [project, extra];
  const event = snapshot(params);
  event.sandboxPolicy.writableRoots = [];
  await expect(confirm(params, event)).rejects.toThrow('execution_unconfirmed');
});
it('does not normalize unavailable requested directories', async () => {
  const params = request();
  params.cwd = join(root, 'missing');
  await expect(confirm(params, snapshot(params))).rejects.toThrow('execution_unconfirmed');
  params.cwd = project;
  params.sandboxPolicy.writableRoots = [join(root, 'missing')];
  await expect(confirm(params, snapshot(params))).rejects.toThrow('execution_unconfirmed');
});
it.each([true, false])(
  'preserves non-workspace sandbox confirmation (readonly=%s)',
  async (readonly) => {
    const params = executionParams(
      'thread-1',
      { id: 'project-1', name: 'Test', path: project },
      'full-access',
      readonly,
      'plan',
      'test-model',
      null,
    );
    await expect(confirm(params, snapshot(params))).resolves.toBeUndefined();
    const event = snapshot(params);
    event.sandboxPolicy.type = 'workspaceWrite';
    await expect(confirm(params, event)).rejects.toThrow('execution_unconfirmed');
  },
);
