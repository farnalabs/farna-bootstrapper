import { z } from 'zod';
import { ID_MAX_LENGTH, ID_RE } from '../core/constants.js';
import { PERMISSION_CATEGORIES, PERMISSION_KEYS } from '../permissions/permissions.js';

export const idSchema = z.string().regex(ID_RE, 'must be lower-case kebab-case').max(ID_MAX_LENGTH);

export const personaSchema = z
  .strictObject({
    kind: z.literal('persona'),
    id: idSchema,
    displayName: z.string().min(1).max(80),
    purpose: z.string().min(1).max(120),
    resources: z.array(z.string().min(1)).max(200),
    model: idSchema.optional(),
    extends: idSchema.optional(),
  })
  .superRefine((persona, ctx) => {
    if (persona.extends === persona.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['extends'],
        message: 'a persona cannot extend itself',
      });
    }
    const seen = new Set<string>();
    for (const ref of persona.resources) {
      const match = /^([a-z]+)\/(.+)$/.exec(ref);
      if (match === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['resources'],
          message: `"${ref}" is not a "kind/id" reference`,
        });
        continue;
      }
      if (seen.has(ref)) {
        ctx.addIssue({
          code: 'custom',
          path: ['resources'],
          message: `duplicate reference "${ref}"`,
        });
      }
      seen.add(ref);
    }
  });

/**
 * A rule has no `description`: nothing would emit it, and a field the tool
 * accepts and ignores is the silent no-op this schema exists to reject. A
 * description is F001 (unknown key).
 */
export const ruleFrontmatterSchema = z.strictObject({
  kind: z.literal('rule'),
  id: idSchema,
  displayName: z.string().min(1).max(80).optional(),
});

const permissionValueSchema = z.enum(['allow', 'ask', 'deny']);

const permissionValueMapSchema = z
  .partialRecord(z.enum(PERMISSION_KEYS), permissionValueSchema)
  .refine(
    (tools) => Object.keys(tools).length >= 1,
    'a permission resource declares at least one category',
  )
  .refine(
    (tools) => Object.keys(tools).length <= 16,
    'a permission resource declares at most sixteen categories',
  );

const permissionPatternMapSchema = z.partialRecord(
  z.enum(PERMISSION_CATEGORIES),
  z.record(z.string().min(1).max(200), permissionValueSchema),
);

export const permissionSchema = z
  .strictObject({
    kind: z.literal('permission'),
    id: idSchema,
    tools: permissionValueMapSchema,
    patterns: permissionPatternMapSchema.optional(),
  })
  .superRefine((permission, ctx) => {
    if (permission.tools['*'] !== undefined) {
      const combined = Object.keys(permission.tools).filter((key) => key !== '*');
      if (combined.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools'],
          message: '"*" cannot be combined with a specific category',
        });
      }
    }
  });

export type PersonaDeclaration = z.infer<typeof personaSchema>;
export type RuleFrontmatter = z.infer<typeof ruleFrontmatterSchema>;
export type PermissionDeclaration = z.infer<typeof permissionSchema>;
