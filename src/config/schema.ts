import { z } from 'zod';
import { ID_RE, SCHEMA_VERSION, SUPPORTED_TARGETS } from '../core/constants.js';

/**
 * One configured target. `active` selects profile mode: exactly that persona is
 * live and owns the workspace. Its existence is checked against the loaded
 * source tree (F001) because the config loader does not read personas; the
 * per-target filter field `exclude` is not implemented, so it is rejected rather
 * than accepted and ignored.
 */
const targetConfigSchema = z.strictObject({
  active: z.string().regex(ID_RE, 'a persona id uses lower-case kebab-case').optional(),
});

export const configSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    targets: z
      .record(z.string(), targetConfigSchema)
      .refine((targets) => Object.keys(targets).length >= 1, 'at least one target is required')
      .refine((targets) => Object.keys(targets).length <= 8, 'at most eight targets are allowed')
      .refine(
        (targets) =>
          Object.keys(targets).every((id) => (SUPPORTED_TARGETS as readonly string[]).includes(id)),
        `this slice supports only: ${SUPPORTED_TARGETS.join(', ')}`,
      )
      .refine(
        (targets) => Object.keys(targets).length === 1,
        'this slice renders exactly one configured target per run; choose claudecode or opencode',
      ),
    models: z.record(z.string(), z.record(z.string(), z.string().min(1))).optional(),
  })
  .superRefine((config, ctx) => {
    for (const modelClass of Object.keys(config.models ?? {})) {
      if (!ID_RE.test(modelClass)) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', modelClass],
          message: 'model class names use lower-case kebab-case',
        });
      }
    }
    for (const [modelClass, mapping] of Object.entries(config.models ?? {})) {
      for (const target of Object.keys(mapping)) {
        if (!(target in config.targets)) {
          ctx.addIssue({
            code: 'custom',
            path: ['models', modelClass, target],
            message: `target "${target}" is not configured`,
          });
        }
      }
    }
  });

export type Config = z.infer<typeof configSchema>;
export type TargetConfig = z.infer<typeof targetConfigSchema>;
