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

/**
 * A command's `description` is required. OpenCode's command file carries it,
 * and a command without one cannot be rendered honestly; the missing field is a
 * deliberate F001 at the source boundary rather than a renderer error later.
 */
export const commandFrontmatterSchema = z.strictObject({
  kind: z.literal('command'),
  id: idSchema,
  description: z.string().min(1).max(200),
});

/**
 * A skill's description is required: OpenCode's `SKILL.md` frontmatter carries
 * it, and a skill without one is not loadable by the harness.
 */
export const skillFrontmatterSchema = z.strictObject({
  kind: z.literal('skill'),
  id: idSchema,
  description: z.string().min(1).max(200),
});

/**
 * An environment-variable reference. The value is a variable name, never a
 * secret: a literal in a credential position is `F002_SECRET_LITERAL`.
 */
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
export const envRefSchema = z.strictObject({
  fromEnv: z
    .string()
    .regex(ENV_NAME_RE, 'environment variable names use upper-case letters, digits and underscore'),
});

/**
 * The parser accepts either a reference or a literal so the loader can raise
 * the precise security code. A literal never reaches the plan: the loader turns
 * any string value into `F002` naming the field and never echoing the value.
 */
const envValueSchema = z.union([envRefSchema, z.string()]);

/** Whitespace (including control whitespace) and other control characters. */
function hasWhitespaceOrControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f;
  });
}

const envKeySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((key) => key !== '__proto__', '__proto__ is not a valid environment or header name');

const stdioServerSchema = z.strictObject({
  type: z.literal('stdio'),
  command: z
    .string()
    .min(1)
    .max(2048)
    .refine(
      (command) => !hasWhitespaceOrControl(command),
      'command must be the program only; put its arguments in args',
    ),
  args: z.array(z.string().max(2048)).max(64).optional(),
  env: z.record(envKeySchema, envValueSchema).optional(),
});

const httpServerSchema = z.strictObject({
  type: z.literal('http'),
  url: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    }, 'an http MCP server needs an absolute http or https URL'),
  headers: z.record(envKeySchema, envValueSchema).optional(),
});

/**
 * One MCP server declaration. `env` and `headers` values are environment
 * references only; the materialiser writes rulesync's canonical `${NAME}`
 * reference, which the OpenCode adapter converts to `{env:NAME}`, so no secret
 * value is ever read by this tool or written into an artefact.
 */
export const mcpSchema = z.strictObject({
  kind: z.literal('mcp'),
  id: idSchema,
  server: z.discriminatedUnion('type', [stdioServerSchema, httpServerSchema]),
});

export const HOOK_PHASES = [
  'before-tool',
  'after-tool',
  'session-start',
  'session-end',
  'stop',
] as const;

/**
 * A hook is data, never executed by this tool. The matcher is interpolated
 * into a generated JavaScript `RegExp`, so it must compile here; a malformed
 * matcher would otherwise produce a plugin that throws when it loads.
 */
export const hookSchema = z
  .strictObject({
    kind: z.literal('hook'),
    id: idSchema,
    phase: z.enum(HOOK_PHASES),
    matcher: z.string().min(1).max(200).optional(),
    command: z.string().min(1).max(2000),
  })
  .superRefine((hook, ctx) => {
    if (/[\n\r\0]/.test(hook.command)) {
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'command cannot contain a newline or NUL',
      });
    }
    if (hook.matcher === undefined) {
      return;
    }
    if (/[\n\r\0]/.test(hook.matcher)) {
      ctx.addIssue({
        code: 'custom',
        path: ['matcher'],
        message: 'matcher cannot contain a newline or NUL',
      });
      return;
    }
    try {
      new RegExp(hook.matcher);
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['matcher'],
        message: 'matcher is not a valid regular expression',
      });
    }
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
export type CommandFrontmatter = z.infer<typeof commandFrontmatterSchema>;
export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
export type PermissionDeclaration = z.infer<typeof permissionSchema>;
export type McpDeclaration = z.infer<typeof mcpSchema>;
export type HookDeclaration = z.infer<typeof hookSchema>;
export type McpServerDeclaration = McpDeclaration['server'];
export type EnvValueInput = z.infer<typeof envValueSchema>;
export type HookPhase = (typeof HOOK_PHASES)[number];
