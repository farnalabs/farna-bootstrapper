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

/** The stricter of two declarations for one OpenCode resource, or the present one. */
function stricterWinner(a: Winner | undefined, b: Winner | undefined): Winner | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return RANK[b.value] > RANK[a.value] ? b : a;
}

/**
 * Map a persona's resolved permission map onto OpenCode's ordered permission
 * records. Measured at rulesync 43.11.0: `bash` becomes `shell`, `task` becomes
 * `subagent`, and `write` folds into `edit` (there is no write category). The
 * fold is reported as W112 when a write-derived allow is emitted without a
 * matching edit declaration. `ask` becomes deny (W111).
 *
 * OpenCode documents last-match-wins, so record order is semantic. The
 * catch-all is always emitted first and the pattern resources keep the order
 * they were declared in: sorting by codepoint could put an earlier allow after
 * a later deny and silently turn a deny into an allow. The source map and the
 * emitted records are produced together so the containment gate asserts the
 * same order the renderer preserves.
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

  const source: OpencodePermissionCategory[] = [];
  const records: OpencodePermissionRecord[] = [];
  for (const mapping of OPENCODE_CATEGORY_ORDER) {
    // One entry per emitted resource, remembering which product categories
    // declared it so the stricter value wins and W112 can be attributed.
    const byResource = new Map<string, Partial<Record<PermissionCategory, Winner>>>();
    const remember = (product: PermissionCategory, resource: string, declared: Winner): void => {
      const bucket = byResource.get(resource) ?? {};
      bucket[product] = declared;
      byResource.set(resource, bucket);
    };
    for (const product of mapping.product) {
      const categoryWinner = resolved.values[product];
      if (categoryWinner !== undefined) {
        remember(product, '*', categoryWinner);
      }
      for (const [resource, declared] of Object.entries(resolved.patterns[product] ?? {})) {
        remember(product, resource, declared);
      }
    }
    if (byResource.size === 0) {
      continue;
    }

    const catchAll = byResource.get('*');
    const catchAllWinner = mapping.product
      .map((product) => catchAll?.[product])
      .reduce<Winner | undefined>((acc, entry) => stricterWinner(acc, entry), undefined);
    const catchAllEffect =
      catchAllWinner === undefined ? undefined : effective(catchAllWinner, mapping.key);

    // The catch-all is first, then every pattern in its source declaration
    // order. `byResource` is insertion-ordered and never codepoint-sorted.
    const ordered: Array<[string, OpencodePermissionEffect]> = [];
    if (catchAllEffect !== undefined) {
      ordered.push(['*', catchAllEffect]);
    }
    for (const [resource, winners] of byResource) {
      if (resource === '*') {
        continue;
      }
      const merged = mapping.product
        .map((product) => winners[product])
        .reduce<Winner | undefined>((acc, entry) => stricterWinner(acc, entry), undefined);
      if (merged === undefined) {
        continue;
      }
      ordered.push([resource, effective(merged, `${mapping.key}(${resource})`)]);
    }

    // A deny catch-all wins: emitting an allow pattern after it would re-allow
    // what the persona denied, and the harness, not this tool, would decide.
    const emitted: Array<[string, OpencodePermissionEffect]> = [];
    for (const [resource, effect] of ordered) {
      if (resource !== '*' && catchAllEffect === 'deny' && effect === 'allow') {
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
        continue;
      }
      emitted.push([resource, effect]);
    }

    // W112 is computed from the emitted edit records, per resource: an allow
    // that exists only because `write` folded into `edit` is a widening. A
    // record whose emitted effect is deny is never a widening, and an unrelated
    // edit allow elsewhere does not cover a resource it does not name.
    if (mapping.key === 'edit') {
      const editCatchAll = resolved.values['edit'];
      for (const [resource, effect] of emitted) {
        if (effect !== 'allow') {
          continue;
        }
        const writeWinner =
          resource === '*' ? resolved.values['write'] : resolved.patterns['write']?.[resource];
        if (writeWinner?.value !== 'allow') {
          continue;
        }
        const editWinner = resource === '*' ? editCatchAll : resolved.patterns['edit']?.[resource];
        const coveredByEdit =
          editWinner !== undefined || (resource !== '*' && editCatchAll?.value === 'allow');
        if (coveredByEdit) {
          continue;
        }
        warnings.push(
          warning({
            code: 'W112_PERMISSION_LOSSY',
            persona: context.persona,
            target: context.target,
            capability: 'permission',
            message: `write is carried as edit on ${context.target}: the allow for edit "${resource}" comes from write and an allow also permits modifying existing files; declare edit to state that intent`,
          }),
        );
      }
    }

    const entry: OpencodePermissionCategory = { key: mapping.key, patterns: emitted };
    for (const [resource, effect] of emitted) {
      records.push({ action: mapping.action, resource, effect });
    }
    source.push(entry);
  }

  return { source, records, warnings };
}

/**
 * The declared patterns as ordered `[pattern, value]` arrays. Object key order
 * carries the source declaration order, and an array keeps it through
 * `canonicalJson`, which sorts object keys but never array members. OpenCode's
 * last-match-wins means two sources that differ only in order are different
 * permissions, so the digest must be order-sensitive too.
 */
function orderedPatternEntries(
  patterns: Partial<Record<PermissionCategory, Record<string, PermissionValue | Winner>>>,
): Record<string, Array<[string, PermissionValue]>> {
  const ordered: Record<string, Array<[string, PermissionValue]>> = {};
  for (const category of PERMISSION_CATEGORIES) {
    const bucket = patterns[category];
    if (bucket === undefined) {
      continue;
    }
    const entries: Array<[string, PermissionValue]> = [];
    for (const [pattern, declared] of Object.entries(bucket)) {
      entries.push([pattern, typeof declared === 'string' ? declared : declared.value]);
    }
    if (entries.length > 0) {
      ordered[category] = entries;
    }
  }
  return ordered;
}

/** The digest of one permission resource's declared content. */
export function permissionResourceDigest(
  tools: PermissionTools,
  patterns: PermissionPatterns | undefined,
  allowlist: boolean,
): string {
  return sha256Hex(
    canonicalJson({ tools, patterns: orderedPatternEntries(patterns ?? {}), allowlist }),
  );
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
  const patterns = orderedPatternEntries(resolved.patterns);
  return sha256Hex(canonicalJson({ values, patterns, allowlist }));
}
