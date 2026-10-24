import { readFileSync } from 'node:fs';
import { z } from 'zod';

const schema = z.strictObject({
  version: z.string().max(80),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  dirty: z.boolean(),
  builtAt: z.iso.datetime().nullable(),
});
export function readBuildInfo() {
  try {
    return schema.parse(
      JSON.parse(readFileSync(new URL('./build-info.json', import.meta.url), 'utf8')),
    );
  } catch {
    return { version: '0.1.0', commit: null, dirty: false, builtAt: null };
  }
}
