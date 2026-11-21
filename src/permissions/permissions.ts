import type { Severity } from '../core/constants.js';
import { permissionUnmapped } from '../core/errors.js';
import { canonicalJson, compareCodepoints, sha256Hex } from '../core/json.js';
import { type Warning, warning } from '../report/warnings.js';

/**
 * The product's permission vocabulary (schema.md section 4.5). This is the only
 * place these words exist; the renderer source tree never receives one of them.
 */
export const PERMISSION_CATEGORIES = [
  'read',
  'write',
  'edit',
  'shell',
  'network',
  'mcp',
  'task',
] as const;

export const PERMISSION_KEYS = [...PERMISSION_CATEGORIES, '*'] as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type PermissionValue = 'allow' | 'ask' | 'deny';

export type PermissionTools = Partial<Record<PermissionKey, PermissionValue>>;
export type PermissionPatterns = Partial<
  Record<PermissionCategory, Record<string, PermissionValue>>
>;

/**
 * The renderer source form for Claude Code's per-agent block is the harness's
 * own tool name, and the emitted byte form is the same string. `Write` is its
 * own tool, distinct from `Edit`; the subagent tool is `Agent` (the former
 * `Task` name is a legacy alias). `network` and a bare `mcp` have no tool.
 *
 * W112 is not emitted here: `write` is native on Claude Code. The lossy
 * `write` -> `edit` collapse in the design belongs to OpenCode (M2b).
 */
export const CLAUDE_TOOL_BY_CATEGORY: Record<'read' | 'write' | 'edit' | 'shell' | 'task', string> =
  {
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    shell: 'Bash',
    task: 'Agent',
  };

const UNMAPPED_CATEGORIES: readonly PermissionCategory[] = ['network', 'mcp'];

const RANK: Record<PermissionValue, number> = { allow: 1, ask: 2, deny: 3 };

export type PermissionContribution = {
  /** The permission resource id, for attribution. */
  id: string;
  tools: PermissionTools;
  patterns: PermissionPatterns;
};

type Winner = { value: PermissionValue; source: string };

export type ResolvedPermissions = {
  values: Partial<Record<PermissionCategory, Winner>>;
  patterns: Partial<Record<PermissionCategory, Record<string, Winner>>>;
};

export type ClaudePermissionEntries = {
  allow: string[];
  deny: string[];
};

export function emptyResolvedPermissions(): ResolvedPermissions {
  return { values: {}, patterns: {} };
}

function expandTools(tools: PermissionTools): Partial<Record<PermissionCategory, PermissionValue>> {
  const expanded: Partial<Record<PermissionCategory, PermissionValue>> = {};
  for (const category of PERMISSION_CATEGORIES) {
    const value = tools[category];
    if (value !== undefined) {
      expanded[category] = value;
    }
  }
  const star = tools['*'];
  if (star !== undefined) {
    for (const category of PERMISSION_CATEGORIES) {
      if (expanded[category] === undefined) {
        expanded[category] = star;
      }
    }
  }
  return expanded;
}

function severityOfLoser(loser: PermissionValue): Severity {
  return loser === 'allow' ? 'medium' : 'info';
}

function mergeWinner(
  current: Winner | undefined,
  incoming: Winner,
  context: { persona: string; target: string; subject: string; kind: 'category' | 'pattern' },
  warnings: Warning[],
): Winner {
  if (current === undefined) {
    return incoming;
  }
  if (current.value === incoming.value) {
    return current;
  }
  const winner = RANK[incoming.value] > RANK[current.value] ? incoming : current;
  const loser = winner === incoming ? current : incoming;
  warnings.push(
    warning({
      code: 'W106_DENY_WINS',
      persona: context.persona,
      target: context.target,
      capability: 'permission',
      severity: severityOfLoser(loser.value),
      message: `${winner.value} wins over ${loser.value} for ${context.kind} "${context.subject}": permission/${winner.source} and permission/${loser.source}`,
    }),
  );
  return winner;
}

/**
 * Union one permission resource into a persona's resolved map. The stricter
 * value wins and every disagreement is reported (W106).
 */
export function mergePermission(
  resolved: ResolvedPermissions,
  contribution: PermissionContribution,
  context: { persona: string; target: string; warnings: Warning[] },
): void {
  const tools = expandTools(contribution.tools);
  for (const category of PERMISSION_CATEGORIES) {
    const value = tools[category];
    if (value === undefined) {
      continue;
    }
    resolved.values[category] = mergeWinner(
      resolved.values[category],
      { value, source: contribution.id },
      { persona: context.persona, target: context.target, subject: category, kind: 'category' },
      context.warnings,
    );
  }
  for (const category of PERMISSION_CATEGORIES) {
    const patterns = contribution.patterns[category];
    if (patterns === undefined) {
      continue;
    }
    const bucket = resolved.patterns[category] ?? {};
    for (const [pattern, value] of Object.entries(patterns)) {
      bucket[pattern] = mergeWinner(
        bucket[pattern],
        { value, source: contribution.id },
        {
          persona: context.persona,
          target: context.target,
          subject: `${category}(${pattern})`,
          kind: 'pattern',
        },
        context.warnings,
      );
    }
    resolved.patterns[category] = bucket;
  }
}

function patternEntry(tool: string, pattern: string): string {
  return `${tool}(${pattern})`;
}

/**
 * Map a persona's resolved permission map onto Claude Code's exact byte form.
 * Every unmapped category refuses with F011 before anything is materialised;
 * `ask` becomes deny (W111). Every mapped category is native here, so no W112.
 */
export function mapPermissions(
  resolved: ResolvedPermissions,
  context: { persona: string; target: string },
): { entries: ClaudePermissionEntries; warnings: Warning[] } {
  const warnings: Warning[] = [];
  for (const category of UNMAPPED_CATEGORIES) {
    const declared = resolved.values[category];
    if (declared !== undefined) {
      throw permissionUnmapped(`the target has no mapping for the "${category}" category`, {
        subject: `${context.target} permission/${category}`,
        action:
          category === 'network'
            ? `declared by permission/${declared.source}; declare read or shell instead, or exclude the target`
            : `declared by permission/${declared.source}; name the MCP server and tool explicitly, or exclude the target`,
      });
    }
    const patterns = resolved.patterns[category];
    if (patterns !== undefined && Object.keys(patterns).length > 0) {
      const source = Object.values(patterns)[0]?.source ?? 'unknown';
      throw permissionUnmapped(`the target has no mapping for the "${category}" category`, {
        subject: `${context.target} permission/${category}`,
        action: `declared by permission/${source}; a pattern on ${category} cannot be carried either`,
      });
    }
  }

  const entries = new Map<string, 'allow' | 'deny'>();
  const record = (entry: string, value: 'allow' | 'deny'): void => {
    const existing = entries.get(entry);
    if (existing === undefined) {
      entries.set(entry, value);
      return;
    }
    if (existing !== value) {
      // Unreachable by construction: every mapped category has its own tool
      // name and every pattern entry carries its own `Tool(P)` spelling, so no
      // two mapping sites can disagree about one entry. Deny-wins is enforced
      // earlier, per category and per pattern, by mergeWinner. If a future
      // mapping table breaks that invariant, fail loudly rather than guess.
      throw new Error(
        `internal invariant violated: permission entry "${entry}" was recorded as both allow and deny`,
      );
    }
  };

  for (const category of PERMISSION_CATEGORIES) {
    const declared = resolved.values[category];
    if (declared === undefined) {
      continue;
    }
    const value = declared.value === 'ask' ? 'deny' : declared.value;
    if (declared.value === 'ask') {
      warnings.push(
        warning({
          code: 'W111_ASK_DOWNGRADED',
          persona: context.persona,
          target: context.target,
          capability: 'permission',
          message: `${category} is declared ask, which ${context.target} has no per-agent surface for; it is emitted as deny`,
        }),
      );
    }
    const tool = CLAUDE_TOOL_BY_CATEGORY[category as keyof typeof CLAUDE_TOOL_BY_CATEGORY];
    record(tool, value === 'allow' ? 'allow' : 'deny');
  }

  for (const category of PERMISSION_CATEGORIES) {
    const patterns = resolved.patterns[category];
    if (patterns === undefined || UNMAPPED_CATEGORIES.includes(category)) {
      continue;
    }
    const tool = CLAUDE_TOOL_BY_CATEGORY[category as keyof typeof CLAUDE_TOOL_BY_CATEGORY];
    // Resolve the category before its patterns: an allow pattern under a
    // category that resolves deny would contradict the bare tool entry in the
    // same file. The harness, not this tool, would decide which wins.
    const categoryValue = resolved.values[category]?.value;
    const categoryEmitted =
      categoryValue === 'deny' || categoryValue === 'ask' ? 'deny' : categoryValue;
    for (const [pattern, declared] of Object.entries(patterns)) {
      const value = declared.value === 'ask' ? 'deny' : declared.value;
      if (declared.value === 'ask') {
        warnings.push(
          warning({
            code: 'W111_ASK_DOWNGRADED',
            persona: context.persona,
            target: context.target,
            capability: 'permission',
            message: `${category}(${pattern}) is declared ask, which ${context.target} has no per-agent surface for; it is emitted as deny`,
          }),
        );
      }
      if (value === 'allow' && categoryEmitted === 'deny') {
        warnings.push(
          warning({
            code: 'W106_DENY_WINS',
            persona: context.persona,
            target: context.target,
            capability: 'permission',
            severity: 'medium',
            message: `${category} resolves deny, so the allow pattern "${pattern}" is not emitted: permission/${declared.source}`,
          }),
        );
        continue;
      }
      record(patternEntry(tool, pattern), value);
    }
  }

  const allow: string[] = [];
  const deny: string[] = [];
  for (const entry of [...entries.keys()].sort(compareCodepoints)) {
    (entries.get(entry) === 'allow' ? allow : deny).push(entry);
  }
  return { entries: { allow, deny }, warnings };
}

/** The digest of one permission resource's declared content. */
export function permissionResourceDigest(
  tools: PermissionTools,
  patterns: PermissionPatterns | undefined,
): string {
  return sha256Hex(canonicalJson({ tools, patterns: patterns ?? {} }));
}

/** The canonical digest input: resolved values and patterns, sorted. */
export function permissionDigest(resolved: ResolvedPermissions): string {
  const values: Record<string, string> = {};
  for (const category of PERMISSION_CATEGORIES) {
    const declared = resolved.values[category];
    if (declared !== undefined) {
      values[category] = declared.value;
    }
  }
  const patterns: Record<string, Record<string, string>> = {};
  for (const category of PERMISSION_CATEGORIES) {
    const bucket = resolved.patterns[category];
    if (bucket === undefined) {
      continue;
    }
    const entry: Record<string, string> = {};
    for (const [pattern, declared] of Object.entries(bucket)) {
      entry[pattern] = declared.value;
    }
    if (Object.keys(entry).length > 0) {
      patterns[category] = entry;
    }
  }
  return sha256Hex(canonicalJson({ values, patterns }));
}
