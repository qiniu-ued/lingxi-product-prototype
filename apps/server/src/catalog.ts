import { type ToolsCatalog, toolsCatalogSchema } from '@lingxi/protocol';
import { z } from 'zod';
import type { CodexClient } from './codex-client.js';

const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  scope: z.string(),
  enabled: z.boolean().nullable().optional().default(null),
  shortDescription: z.string().optional(),
  interface: z
    .object({ displayName: z.string().optional(), shortDescription: z.string().optional() })
    .optional(),
});
const skillsSchema = z.object({
  data: z.array(
    z.object({
      skills: z.array(skillSchema),
      errors: z.array(z.object({ path: z.string() })).default([]),
    }),
  ),
});
const mcpSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      runtimeStatus: z.string().nullable().optional().default(null),
      authStatus: z.string().default('unknown'),
      toolsError: z.string().nullable().optional(),
      tools: z
        .record(
          z.string(),
          z.object({ name: z.string().optional(), description: z.string().optional() }),
        )
        .default({}),
      resources: z.array(z.unknown()).default([]),
      resourceTemplates: z.array(z.unknown()).default([]),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});
const bucketSchema = toolsCatalogSchema.shape.limits.shape.buckets.element;
const rawBucket = z.object({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  primary: bucketSchema.shape.primary.default(null),
  secondary: bucketSchema.shape.secondary.default(null),
  credits: bucketSchema.shape.credits.default(null),
});
const limitsSchema = z.object({
  ordinaryUsageAllowed: z.boolean().nullable().optional().default(null),
  rateLimits: rawBucket.nullable().optional(),
  rateLimitsByLimitId: z.record(z.string(), rawBucket).nullable().optional(),
});
export async function listMcp(client: Pick<CodexClient, 'request'>) {
  const data: z.infer<typeof mcpSchema>['data'] = [],
    seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = mcpSchema.parse(
      await client.request('mcpServerStatus/list', { limit: 100, ...(cursor ? { cursor } : {}) }),
    );
    data.push(...page.data);
    cursor = page.nextCursor ?? null;
    if (data.length > 1000 || seen.size >= 10 || (cursor && seen.has(cursor)))
      throw new Error('mcp_catalog_limit');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { data };
}
export function normalizeCatalog(
  projectId: string,
  skills: unknown,
  mcp: unknown,
  limits: unknown,
): ToolsCatalog {
  const s = skillsSchema.safeParse(skills),
    m = mcpSchema.safeParse(mcp),
    l = limitsSchema.safeParse(limits);
  const buckets = l.success
    ? Object.entries(l.data.rateLimitsByLimitId ?? {}).length
      ? Object.entries(l.data.rateLimitsByLimitId ?? {})
      : l.data.rateLimits
        ? [[l.data.rateLimits.limitId ?? 'codex', l.data.rateLimits] as const]
        : []
    : [];
  return toolsCatalogSchema.parse({
    projectId,
    skills: {
      status: s.success ? 'ready' : 'unavailable',
      items: s.success
        ? s.data.data.flatMap((entry) =>
            entry.skills.map((skill) => ({
              name: skill.name,
              displayName: skill.interface?.displayName ?? skill.name,
              description:
                skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description,
              path: skill.path,
              scope: skill.scope,
              enabled: skill.enabled,
            })),
          )
        : [],
      issues: s.success
        ? s.data.data.flatMap((entry) =>
            entry.errors.map((error) => ({
              path: error.path,
              message: '无法加载此技能，请检查 SKILL.md 格式。',
            })),
          )
        : [],
    },
    mcp: {
      status: m.success ? 'ready' : 'unavailable',
      items: m.success
        ? m.data.data.map((server) => ({
            name: server.name,
            runtimeStatus: server.runtimeStatus,
            authStatus: server.authStatus,
            toolsUnavailable: !!server.toolsError,
            tools: Object.entries(server.tools).map(([name, tool]) => ({
              name: tool.name ?? name,
              description: tool.description ?? '',
            })),
            resourceCount: server.resources.length + server.resourceTemplates.length,
          }))
        : [],
    },
    limits: {
      status: l.success ? 'ready' : 'unavailable',
      ordinaryUsageAllowed: l.success ? l.data.ordinaryUsageAllowed : null,
      buckets: buckets.map(([id, bucket]) => ({
        id,
        name: bucket.limitName ?? bucket.limitId ?? id,
        primary: bucket.primary,
        secondary: bucket.secondary,
        credits: bucket.credits,
      })),
    },
  });
}
