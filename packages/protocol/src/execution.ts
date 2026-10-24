import { z } from 'zod';

export const permissionModeSchema = z.enum(['manual', 'auto-review', 'full-access']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const executionOptionsSchema = z.object({
  projectId: z.uuid(),
  plan: z.boolean(),
  defaultMode: z.boolean().default(false),
  permissions: z.object({
    manual: z.boolean(),
    'auto-review': z.boolean(),
    'full-access': z.boolean(),
  }),
  verified: z
    .array(z.enum(['plan', 'default', 'manual', 'auto-review', 'full-access']))
    .default([]),
});
export type ExecutionOptions = z.infer<typeof executionOptionsSchema>;
