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
  /**
   * True when the resource opts its persona into the target's `tools`
   * allow-list. The default is a deny-list: a partial allow set is not an
   * exhaustive allow-list.
   */
  allowlist: boolean;
};

type Winner = { value: PermissionValue; source: string };

export type ResolvedPermissions = {
  values: Partial<Record<PermissionCategory, Winner>>;
  patterns: Partial<Record<PermissionCategory, Record<string, Winner>>>;
  /** True when any contributing resource declared `allowlist: true`. */
  allowlist: boolean;
};

export type ClaudePermissionEntries = {
  allow: string[];
  deny: string[];
};

export function emptyResolvedPermissions(): ResolvedPermissions {
  return { values: {}, patterns: {}, allowlist: false };
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
  resolved.allowlist = resolved.allowlist || contribution.allowlist;
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
 * Refuse a category that has no mapping on the configured target, before
 * anything is materialised. Emitting an inert string is the false negative this
 * product exists to prevent, so an unmapped category is F011, never a
 * passthrough.
 */
export function assertPermissionCategoriesMappable(
  resolved: ResolvedPermissions,
  context: { target: string },
): void {
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
}

/**
 * Map a persona's resolved permission map onto Claude Code's exact byte form.
 * Every unmapped category refuses with F011 before anything is materialised;
 * `ask` becomes deny (W111). Every mapped category is native here, so no W112.
 */
export function mapPermissions(
  resolved: ResolvedPermissions,
  context: { persona: string; target: string },
): { entries: ClaudePermissionEntries; allowlist: boolean; warnings: Warning[] } {
  const warnings: Warning[] = [];
  assertPermissionCategoriesMappable(resolved, context);

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
  // Claude Code's `tools` is an ALLOW-list, not a set of extra grants: emitting
  // a partial set removes every tool it does not name. Only a resource that
  // explicitly opts in may narrow the persona to that list, and the narrowing
  // is reported.
  //
  // The effective flag is exactly what decides emission. An explicit opt-in
  // whose categories all resolve deny/ask leaves no entry to list; emitting
  // `tools: []` would remove every tool (a silent total lockdown), so the field
  // is omitted and the no-effect case is reported as W113 rather than dropped
  // silently. This same effective flag is what the persona's digest records.
  const allowlist = resolved.allowlist && allow.length > 0;
  if (allowlist) {
    warnings.push(
      warning({
        code: 'W113_ALLOW_LIST_NARROWS',
        persona: context.persona,
        target: context.target,
        capability: 'permission',
        message: `tools is an allow-list for ${context.target}: it lists ${allow.join(', ')} only, so every unmodelled tool (Glob, Grep, WebFetch, TodoWrite, NotebookEdit and others) is removed`,
      }),
    );
  } else if (resolved.allowlist) {
    const removed = PERMISSION_CATEGORIES.flatMap((category) => {
      const declared = resolved.values[category];
      return declared !== undefined && declared.value !== 'allow'
        ? [`${category} (${declared.value} by permission/${declared.source})`]
        : [];
    });
    const detail =
      removed.length === 0 ? 'no category resolved allow' : `removed by ${removed.join(', ')}`;
    warnings.push(
      warning({
        code: 'W113_ALLOW_LIST_NARROWS',
        persona: context.persona,
        target: context.target,
        capability: 'permission',
        message: `an allow-list was requested for ${context.target}, but ${detail}; tools is not emitted, so the opt-in has no effect`,
      }),
    );
  }
  return { entries: { allow, deny }, allowlist, warnings };
}

export type OpencodePermissionEffect = 'allow' | 'deny';

/** One `{ action, resource, effect }` record OpenCode reads, last match wins. */
export type OpencodePermissionRecord = {
  action: 'read' | 'edit' | 'shell' | 'subagent';
  resource: string;
  effect: OpencodePermissionEffect;
};

/** One canonical category as it is written into the rulesync source tree. */
export type OpencodePermissionCategory = {
  key: 'read' | 'edit' | 'bash' | 'task';
  patterns: Array<[string, OpencodePermissionEffect]>;
};

export type OpencodePermissionMapping = {
  /** The rulesync `permission` map, in canonical order. */
  source: OpencodePermissionCategory[];
  /** The records rulesync emits from that map, in the same order. */
  records: OpencodePermissionRecord[];
  warnings: Warning[];
};

const OPENCODE_CATEGORY_ORDER: ReadonlyArray<{
  key: OpencodePermissionCategory['key'];
  action: OpencodePermissionRecord['action'];
  product: readonly PermissionCategory[];
}> = [
  { key: 'read', action: 'read', product: ['read'] },
  // OpenCode has no `write` category: `write` and `edit` both land as `edit`.
  { key: 'edit', action: 'edit', product: ['write', 'edit'] },
  { key: 'bash', action: 'shell', product: ['shell'] },
  { key: 'task', action: 'subagent', product: ['task'] },
];

/**
 * Map a persona's resolved permission map onto OpenCode's ordered permission
 * records. Measured at rulesync 43.11.0: `bash` becomes `shell`, `task` becomes
 * `subagent`, and `write` folds into `edit` (there is no write category). The
 * fold is reported as W112 because an `allow` now also permits modifying
 * existing files. `ask` becomes deny (W111) because no ask effect is measured.
 *
 * The source map and the emitted records are produced together so the
 * containment gate asserts the same order the renderer preserves.
 */
export function mapOpencodePermissions(
  resolved: ResolvedPermissions,
  context: { persona: string; target: string },
): OpencodePermissionMapping {
  const warnings: Warning[] = [];
  assertPermissionCategoriesMappable(resolved, context);

  const effective = (declared: Winner, subject: string): OpencodePermissionEffect => {
    if (declared.value !== 'ask') {
      return declared.value;
    }
    warnings.push(
      warning({
        code: 'W111_ASK_DOWNGRADED',
        persona: context.persona,
        target: context.target,
        capability: 'permission',
        message: `${subject} is declared ask, which ${context.target} has no measured surface for; it is emitted as deny`,
      }),
    );
    return 'deny';
  };

  // W112 is the widening case only: a `write` declaration that contributes an
  // `allow` while no `edit` declaration already states that intent. A `write`
  // that resolves deny is folded into edit with no widening, so it is not
  // reported: a stricter rule must never be presented as a loss.
  const writePatterns = Object.values(resolved.patterns['write'] ?? {});
  const editPatterns = Object.values(resolved.patterns['edit'] ?? {});
  const writeAllows =
    resolved.values['write']?.value === 'allow' ||
    writePatterns.some((pattern) => pattern.value === 'allow');
  const editAllows =
    resolved.values['edit']?.value === 'allow' ||
    editPatterns.some((pattern) => pattern.value === 'allow');
  if (writeAllows && !editAllows) {
    warnings.push(
      warning({
        code: 'W112_PERMISSION_LOSSY',
        persona: context.persona,
        target: context.target,
        capability: 'permission',
        message: `write is carried as edit on ${context.target}: an allow also permits modifying existing files; declare edit to state that intent`,
      }),
    );
  }

  const source: OpencodePermissionCategory[] = [];
  const records: OpencodePermissionRecord[] = [];
  for (const mapping of OPENCODE_CATEGORY_ORDER) {
    // Merge the product categories that share one OpenCode category, the
    // stricter effect winning. `write` and `edit` are the only such pair.
    const patterns = new Map<string, OpencodePermissionEffect>();
    const recordPattern = (resource: string, effect: OpencodePermissionEffect): void => {
      const existing = patterns.get(resource);
      if (existing === undefined || (existing === 'allow' && effect === 'deny')) {
        patterns.set(resource, effect);
      }
    };
    for (const product of mapping.product) {
      const declared = resolved.values[product];
      if (declared !== undefined) {
        recordPattern('*', effective(declared, product));
      }
      for (const [resource, declaredPattern] of Object.entries(resolved.patterns[product] ?? {})) {
        recordPattern(resource, effective(declaredPattern, `${product}(${resource})`));
      }
    }
    if (patterns.size === 0) {
      continue;
    }
    // A deny catch-all wins: emitting an allow pattern after it would re-allow
    // what the persona denied, and the harness, not this tool, would decide.
    if (patterns.get('*') === 'deny') {
      for (const [resource, effect] of [...patterns]) {
        if (resource !== '*' && effect === 'allow') {
          patterns.delete(resource);
          warnings.push(
            warning({
              code: 'W106_DENY_WINS',
              persona: context.persona,
              target: context.target,
              capability: 'permission',
              severity: 'medium',
              message: `${mapping.key} resolves deny, so the allow pattern "${resource}" is not emitted`,
            }),
          );
        }
      }
    }
    const ordered = [
      ...(patterns.has('*') ? ([['*', patterns.get('*')]] as const) : []),
      ...[...patterns.entries()]
        .filter(([resource]) => resource !== '*')
        .sort((a, b) => compareCodepoints(a[0], b[0])),
    ];
    const entry: OpencodePermissionCategory = { key: mapping.key, patterns: [] };
    for (const [resource, effect] of ordered) {
      if (effect === undefined) {
        continue;
      }
      entry.patterns.push([resource, effect]);
      records.push({ action: mapping.action, resource, effect });
    }
    source.push(entry);
  }

  return { source, records, warnings };
}

/** The digest of one permission resource's declared content. */
export function permissionResourceDigest(
  tools: PermissionTools,
  patterns: PermissionPatterns | undefined,
  allowlist: boolean,
): string {
  return sha256Hex(canonicalJson({ tools, patterns: patterns ?? {}, allowlist }));
}

/**
 * The canonical digest input: resolved values and patterns, sorted, plus the
 * allow-list flag that actually decided emission. Passing the effective flag
 * (never the raw opt-in) keeps the digest consistent with the artefact: an
 * opt-in with nothing to allow emits no `tools`, so it must not change the
 * digest either.
 */
export function permissionDigest(resolved: ResolvedPermissions, allowlist: boolean): string {
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
  return sha256Hex(canonicalJson({ values, patterns, allowlist }));
}
