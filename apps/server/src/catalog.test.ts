import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { listMcp, normalizeCatalog } from './catalog.js';

it('projects readable catalogs, quotas and partial failures without exposing provider configuration', () => {
  const result = normalizeCatalog(
    randomUUID(),
    {
      data: [
        {
          cwd: '/project',
          skills: [
            {
              name: 'review',
              description: 'Review code',
              shortDescription: 'Short',
              path: '/skills/review/SKILL.md',
              scope: 'user',
              enabled: true,
              interface: { displayName: '代码审阅', shortDescription: '检查修改并给出建议' },
            },
          ],
          errors: [{ path: '/bad/SKILL.md', message: 'PRIVATE RAW ERROR' }],
        },
      ],
    },
    {
      data: [
        {
          name: 'preview',
          runtimeStatus: 'connected',
          authStatus: 'bearerToken',
          secret: 'PRIVATE TOKEN',
          tools: { click: { name: 'click', description: '点击作品' }, snapshot: {} },
          resources: [{}],
          toolsError: 'PRIVATE ERROR',
        },
      ],
    },
    {
      ordinaryUsageAllowed: false,
      rateLimits: null,
      accountId: 'PRIVATE ACCOUNT',
      rateLimitsByLimitId: {
        codex: {
          limitName: 'Codex',
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1800000000 },
          credits: { hasCredits: true, unlimited: false, balance: '10' },
        },
      },
    },
  );
  expect(result.skills.items[0]).toMatchObject({
    displayName: '代码审阅',
    description: '检查修改并给出建议',
    enabled: true,
  });
  expect(result.mcp.items[0]).toMatchObject({
    runtimeStatus: 'connected',
    toolsUnavailable: true,
    resourceCount: 1,
    tools: [
      { name: 'click', description: '点击作品' },
      { name: 'snapshot', description: '' },
    ],
  });
  expect(result.limits).toMatchObject({
    ordinaryUsageAllowed: false,
    buckets: [{ id: 'codex', name: 'Codex', primary: { usedPercent: 20 } }],
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
it('preserves unknown states and keeps one failed category independent of the others', () => {
  const result = normalizeCatalog(
    randomUUID(),
    {
      data: [{ skills: [{ name: 'example', description: 'long', path: '/skill', scope: 'repo' }] }],
    },
    null,
    { rateLimits: { limitId: 'codex', primary: null } },
  );
  expect(result.skills.items[0]?.enabled).toBeNull();
  expect(result.mcp.status).toBe('unavailable');
  expect(result.limits).toMatchObject({
    status: 'ready',
    ordinaryUsageAllowed: null,
    buckets: [{ id: 'codex', name: 'codex', primary: null, secondary: null, credits: null }],
  });
  const empty = normalizeCatalog(randomUUID(), null, { data: [] }, null);
  expect(empty.skills.status).toBe('unavailable');
  expect(empty.mcp).toEqual({ status: 'ready', items: [] });
  expect(empty.limits.status).toBe('unavailable');
});
it('reads complete MCP pagination and stops a repeated cursor', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ data: [{ name: 'first' }], nextCursor: 'page2' })
    .mockResolvedValueOnce({ data: [{ name: 'second' }], nextCursor: null });
  expect((await listMcp({ request })).data.map((s) => s.name)).toEqual(['first', 'second']);
  expect(request.mock.calls[1]?.[1]).toMatchObject({ cursor: 'page2' });
  request.mockResolvedValue({ data: [], nextCursor: 'loop' });
  await expect(listMcp({ request })).rejects.toThrow('mcp_catalog_limit');
});
