import type { ExecutionOptions, PermissionMode, Project } from '@lingxi/protocol';
import { z } from 'zod';
import type { CodexClient } from './codex-client.js';

const modesSchema = z.object({ data: z.array(z.object({ mode: z.string().nullable() })) });
const requirementsSchema = z.object({
  requirements: z
    .object({
      allowedApprovalPolicies: z.array(z.unknown()).nullable().optional(),
      allowedApprovalsReviewers: z.array(z.string()).nullable().optional(),
      allowedSandboxModes: z.array(z.string()).nullable().optional(),
    })
    .nullable(),
});
export async function executionOptions(
  client: CodexClient,
  projectId: string,
): Promise<ExecutionOptions> {
  const [modes, requirements] = await Promise.allSettled([
    client.request('collaborationMode/list', {}),
    client.request('config/requirements/read', {}),
  ]);
  const parsedModes = modes.status === 'fulfilled' ? modesSchema.safeParse(modes.value) : null;
  const parsedRequirements =
    requirements.status === 'fulfilled' ? requirementsSchema.safeParse(requirements.value) : null;
  const policy = parsedRequirements?.success ? parsedRequirements.data.requirements : undefined;
  const allowed = (list: unknown[] | null | undefined, value: string) =>
    !list || list.includes(value);
  return {
    projectId,
    plan:
      !!parsedModes?.success &&
      ['plan', 'default'].every((mode) => parsedModes.data.data.some((m) => m.mode === mode)),
    defaultMode:
      !!parsedModes?.success && parsedModes.data.data.some((mode) => mode.mode === 'default'),
    permissions: {
      manual:
        policy === undefined ||
        (allowed(policy?.allowedApprovalPolicies, 'on-request') &&
          allowed(policy?.allowedApprovalsReviewers, 'user') &&
          allowed(policy?.allowedSandboxModes, 'workspace-write')),
      'auto-review':
        policy !== undefined &&
        allowed(policy?.allowedApprovalPolicies, 'on-request') &&
        allowed(policy?.allowedApprovalsReviewers, 'auto_review') &&
        allowed(policy?.allowedSandboxModes, 'workspace-write'),
      'full-access':
        policy !== undefined &&
        allowed(policy?.allowedApprovalPolicies, 'never') &&
        allowed(policy?.allowedApprovalsReviewers, 'user') &&
        allowed(policy?.allowedSandboxModes, 'danger-full-access'),
    },
    verified: [],
  };
}
export function executionParams(
  threadId: string,
  project: Project,
  permission: PermissionMode,
  readonly: boolean,
  mode: 'plan' | 'default',
  model: string,
  effort: string | null,
) {
  const approvalPolicy = readonly || permission === 'full-access' ? 'never' : 'on-request';
  const approvalsReviewer = !readonly && permission === 'auto-review' ? 'auto_review' : 'user';
  const sandboxPolicy = readonly
    ? { type: 'readOnly', networkAccess: false }
    : permission === 'full-access'
      ? { type: 'dangerFullAccess' }
      : {
          type: 'workspaceWrite',
          writableRoots: [project.path],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        };
  return {
    threadId,
    approvalPolicy,
    approvalsReviewer,
    sandboxPolicy,
    collaborationMode: {
      mode,
      settings: { model, reasoning_effort: effort, developer_instructions: null },
    },
  };
}
export async function applyExecution(
  client: CodexClient,
  params: ReturnType<typeof executionParams>,
) {
  await client.updateSettings(params, (value) => {
    const event = z
      .object({
        approvalPolicy: z.unknown(),
        approvalsReviewer: z.string(),
        sandboxPolicy: z.record(z.string(), z.unknown()),
        collaborationMode: z.object({
          mode: z.string(),
          settings: z.object({ model: z.string(), reasoning_effort: z.string().nullable() }),
        }),
      })
      .safeParse(value);
    return (
      event.success &&
      event.data.approvalPolicy === params.approvalPolicy &&
      event.data.approvalsReviewer === params.approvalsReviewer &&
      Object.entries(params.sandboxPolicy).every(
        ([key, value]) => JSON.stringify(event.data.sandboxPolicy[key]) === JSON.stringify(value),
      ) &&
      event.data.collaborationMode.mode === params.collaborationMode.mode &&
      event.data.collaborationMode.settings.model === params.collaborationMode.settings.model &&
      event.data.collaborationMode.settings.reasoning_effort ===
        params.collaborationMode.settings.reasoning_effort
    );
  });
}
