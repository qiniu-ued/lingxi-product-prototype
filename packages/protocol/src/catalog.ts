import { z } from 'zod';

const status = z.enum(['ready', 'unavailable']);
const windowSchema = z.object({
  usedPercent: z.number().finite().nonnegative(),
  windowDurationMins: z.number().int().positive().nullable().default(null),
  resetsAt: z.number().int().nonnegative().nullable().default(null),
});
export const toolsCatalogSchema = z.object({
  projectId: z.uuid(),
  skills: z.object({
    status,
    items: z.array(
      z.object({
        name: z.string(),
        displayName: z.string(),
        description: z.string(),
        path: z.string(),
        scope: z.string(),
        enabled: z.boolean().nullable(),
      }),
    ),
    issues: z.array(z.object({ path: z.string(), message: z.string() })),
  }),
  mcp: z.object({
    status,
    items: z.array(
      z.object({
        name: z.string(),
        runtimeStatus: z.string().nullable(),
        authStatus: z.string(),
        toolsUnavailable: z.boolean(),
        tools: z.array(z.object({ name: z.string(), description: z.string() })),
        resourceCount: z.number().int().nonnegative(),
      }),
    ),
  }),
  limits: z.object({
    status,
    ordinaryUsageAllowed: z.boolean().nullable(),
    buckets: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        primary: windowSchema.nullable(),
        secondary: windowSchema.nullable(),
        credits: z
          .object({
            unlimited: z.boolean(),
            hasCredits: z.boolean(),
            balance: z.string().nullable(),
          })
          .nullable(),
      }),
    ),
  }),
});
export type ToolsCatalog = z.infer<typeof toolsCatalogSchema>;
