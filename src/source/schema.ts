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

/**
 * A pattern is interpolated verbatim into the target's `Tool(pattern)` grammar.
 * A pattern carrying `)` or `,` would change the entry's meaning, a newline or
 * control character would break the line-oriented frontmatter, and padding is
 * never intentional. All are refused at the source boundary rather than escaped,
 * because the harness's grammar has no escaping this tool can verify.
 */
function describePatternProblem(pattern: string): string | undefined {
  if (pattern !== pattern.trim()) {
    return 'pattern has leading or trailing whitespace';
  }
  const hasControl = [...pattern].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
  if (hasControl) {
    return 'pattern contains a newline or control character';
  }
  if (pattern.includes(')') || pattern.includes(',')) {
    return 'pattern cannot contain ")" or ",": it is interpolated into the target grammar Tool(pattern) and is not representable';
  }
  return undefined;
}

const patternRecordSchema = z
  .record(z.string().min(1).max(200), permissionValueSchema)
  .superRefine((record, ctx) => {
    for (const pattern of Object.keys(record)) {
      const problem = describePatternProblem(pattern);
      if (problem !== undefined) {
        ctx.addIssue({ code: 'custom', path: [pattern], message: problem });
      }
    }
  });

const permissionPatternMapSchema = z.partialRecord(
  z.enum(PERMISSION_CATEGORIES),
  patternRecordSchema,
);

export const permissionSchema = z
  .strictObject({
    kind: z.literal('permission'),
    id: idSchema,
    tools: permissionValueMapSchema,
    /**
     * Opt in to Claude Code's `tools` allow-list. The default is a deny-list:
     * an allow entry grants nothing extra, but a partial `tools` list removes
     * every tool it does not name. Only `true` narrows the persona.
     */
    allowlist: z.boolean().optional(),
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
