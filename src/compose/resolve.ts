import type { Config } from '../config/schema.js';
import {
  CONFIG_PATH,
  isOpencodeTarget,
  MAX_EXTENDS_DEPTH,
  MODE_AGENT,
  MODE_PROFILE,
  OPENCODE_WORKSPACE_KINDS,
  type PersonaMode,
  PROFILE_FORCING_KINDS,
  PROFILE_TARGETS,
  type RenderMode,
  SUPPORTED_RESOURCE_KINDS,
  SUPPORTED_TARGETS,
  type SupportedTarget,
  targetSupportsProfile,
} from '../core/constants.js';
import { conflict, invalidConfig } from '../core/errors.js';
import { canonicalJson, compareCodepoints, sha256Hex } from '../core/json.js';
import {
  emptyResolvedPermissions,
  mapOpencodePermissions,
  mapPermissions,
  mergePermission,
  type OpencodePermissionCategory,
  type OpencodePermissionRecord,
  type PermissionContribution,
  permissionDigest,
  permissionResourceDigest,
  type ResolvedPermissions,
} from '../permissions/permissions.js';
import { sortWarnings, type Warning, warning } from '../report/warnings.js';
import type {
  CommandResource,
  HookResource,
  LoadedPersona,
  McpResource,
  PermissionResource,
  RuleResource,
  SkillFile,
  SkillResource,
  SourceTree,
} from '../source/load.js';

/** The persona field a source-derived warning carries when no persona declared it. */
const SOURCE_WARNING_SUBJECT = '<source>';

export type ResolvedRule = {
  kind: 'rule';
  id: string;
  displayName: string;
  body: string;
  sha256: string;
  path: string;
  /** The persona in the composition chain that contributed this resource. */
  fromPersona: string;
};

export type ResolvedPermission = {
  kind: 'permission';
  id: string;
  sha256: string;
  path: string;
  fromPersona: string;
};

export type ResolvedCommand = {
  kind: 'command';
  id: string;
  description?: string;
  body: string;
  sha256: string;
  path: string;
  fromPersona: string;
};

export type ResolvedSkill = {
  kind: 'skill';
  id: string;
  description: string;
  body: string;
  files: SkillFile[];
  sha256: string;
  path: string;
  fromPersona: string;
};

export type ResolvedMcp = {
  kind: 'mcp';
  id: string;
  server: McpResource['server'];
  sha256: string;
  path: string;
  fromPersona: string;
};

export type ResolvedHook = {
  kind: 'hook';
  id: string;
  phase: HookResource['phase'];
  matcher?: string;
  command: string;
  sha256: string;
  path: string;
  fromPersona: string;
};

export type ResolvedResource =
  | ResolvedRule
  | ResolvedPermission
  | ResolvedCommand
  | ResolvedSkill
  | ResolvedMcp
  | ResolvedHook;

/**
 * A hook plus whether this target can carry it. A hook OpenCode cannot express
 * is kept in the resolved set (so the lockfile still records the declaration)
 * but is never materialised; `reason` is what the warning prints.
 */
export type ResolvedHookOutcome = ResolvedHook & {
  carried: boolean;
  reason?: string;
};

export type ResolvedPersona = {
  id: string;
  displayName: string;
  purpose: string;
  /** The base persona id when this persona is composed. */
  extends?: string;
  /** The full composition chain, base first, this persona last. */
  chain: string[];
  /**
   * The effective OpenCode agent mode this persona declares, with a composed
   * base's value overridden by its children. Absent means no persona in the
   * chain declared one, so the target emits its default (`subagent`). The
   * field is not emitted on Claude Code, which has no such concept.
   */
  mode?: PersonaMode;
  rules: ResolvedRule[];
  mcp: ResolvedMcp[];
  skills: ResolvedSkill[];
  commands: ResolvedCommand[];
  hooks: ResolvedHookOutcome[];
  /** Every resolved resource, canonically ordered, each sorted by id. */
  resources: ResolvedResource[];
  permissions: ResolvedPermissions;
  /**
   * The exact Claude Code entries, already sorted and capitalised. Empty on a
   * target that is not Claude Code. `allowlist` is true only when a contributing
   * permission resource opted in: by default the entries are a deny-list,
   * because `tools` is an allow-list in the target.
   */
  claude: { allow: string[]; deny: string[]; allowlist: boolean };
  /** The rulesync permission map and the records OpenCode emits from it. */
  opencode: {
    permission: OpencodePermissionCategory[];
    records: OpencodePermissionRecord[];
  };
  model?: string;
  path: string;
  /** Canonical digest of the persona's resolved resources. */
  digest: string;
  /** Canonical digest of the resolved permission map. */
  permissionDigest: string;
  warnings: Warning[];
};

export type ResolvedSource = {
  target: SupportedTarget;
  /** `profile` when one persona owns the workspace, `agent` otherwise. */
  mode: RenderMode;
  /** The active persona id in profile mode; `null` in agent mode. */
  active: string | null;
  /** Every persona resolved but not live, sorted. Empty in agent mode. */
  notLive: string[];
  personas: ResolvedPersona[];
  /** Every workspace resource any live persona declares, deduplicated by id. */
  mcp: ResolvedMcp[];
  skills: ResolvedSkill[];
  commands: ResolvedCommand[];
  hooks: ResolvedHookOutcome[];
  warnings: Warning[];
};

/**
 * The one selection override the CLI accepts. A present persona wins over
 * `targets.<target>.active`; both select profile mode.
 */
export type SourceSelection = {
  persona?: string;
};

const KIND_ORDER: Record<string, number> = {
  rule: 0,
  permission: 1,
  model: 2,
  mcp: 3,
  skill: 4,
  command: 5,
  hook: 6,
};

function splitRef(ref: string): { kind: string; id: string } {
  const separator = ref.indexOf('/');
  return { kind: ref.slice(0, separator), id: ref.slice(separator + 1) };
}

/** The one configured target. The config schema admits exactly one. */
export function configuredTarget(config: Config): SupportedTarget {
  const [id] = Object.keys(config.targets);
  if (id === undefined || !(SUPPORTED_TARGETS as readonly string[]).includes(id)) {
    throw invalidConfig('no supported target is configured', {
      subject: '.farna/config.jsonc',
      action: `configure exactly one of: ${SUPPORTED_TARGETS.join(', ')}`,
    });
  }
  return id as SupportedTarget;
}

/**
 * Resolve `extends` to the full chain, base first. Cycles, a missing base and a
 * depth over the limit are all F001; the cycle message names the whole path.
 */
function resolveChain(persona: LoadedPersona, byId: Map<string, LoadedPersona>): LoadedPersona[] {
  const chain: LoadedPersona[] = [];
  const visiting: string[] = [];
  let current: LoadedPersona | undefined = persona;
  while (current !== undefined) {
    const cycleAt = visiting.indexOf(current.id);
    if (cycleAt !== -1) {
      const path = [...visiting.slice(cycleAt), current.id].join(' -> ');
      throw invalidConfig(`extends cycle: ${path}`, {
        subject: current.path,
        action: 'remove one edge so the composition chain has a base',
      });
    }
    if (visiting.length >= MAX_EXTENDS_DEPTH) {
      throw invalidConfig(`extends chain is deeper than ${MAX_EXTENDS_DEPTH}`, {
        subject: persona.path,
      });
    }
    visiting.push(current.id);
    chain.unshift(current);
    if (current.extends === undefined) {
      break;
    }
    const base = byId.get(current.extends);
    if (base === undefined) {
      throw invalidConfig(`extends "${current.extends}" names no persona`, {
        subject: current.path,
        action: 'add the base persona under .farna/personas/',
      });
    }
    current = base;
  }
  return chain;
}

function resolveModelClass(
  modelClass: string,
  subject: string,
  config: Config,
  target: SupportedTarget,
): string {
  const mapping = config.models?.[modelClass];
  if (mapping === undefined) {
    throw invalidConfig(`model class "${modelClass}" is not declared in config.models`, {
      subject,
    });
  }
  const modelId = mapping[target];
  if (modelId === undefined) {
    throw invalidConfig(`model class "${modelClass}" has no "${target}" mapping`, {
      subject,
    });
  }
  return modelId;
}

/**
 * The model is inherited from the base or set on the persona. Two different
 * concrete models in one composed set is F005: composition never silently
 * changes the model. Two classes that resolve to the same model id are one
 * model and do not conflict.
 */
function resolveModel(
  chain: LoadedPersona[],
  config: Config,
  target: SupportedTarget,
): string | undefined {
  const declared = chain
    .filter((persona) => persona.model !== undefined)
    .map((persona) => ({
      persona,
      modelClass: persona.model as string,
      modelId: resolveModelClass(persona.model as string, persona.path, config, target),
    }));
  const distinct = [...new Set(declared.map((entry) => entry.modelId))];
  if (distinct.length > 1) {
    const [first, second] = declared as [(typeof declared)[number], (typeof declared)[number]];
    throw conflict(
      `composed persona declares two different models: "${first.modelClass}" -> "${first.modelId}" and "${second.modelClass}" -> "${second.modelId}"`,
      {
        subject: second.persona.path,
        action: `the same model must be inherited or set once; ${first.persona.path} sets "${first.modelClass}"`,
      },
    );
  }
  return distinct[0];
}

/**
 * The mode a composed persona declares. A mode is inherited from the base and
 * overridden by the most derived persona that declares one; a chain with no
 * declaration returns `undefined`, which is the target's default. Unlike the
 * model there is no conflict: the child is the more specific declaration, so
 * overriding is the intended composition.
 */
function resolveMode(chain: LoadedPersona[]): PersonaMode | undefined {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const declared = chain[index]?.mode;
    if (declared !== undefined) {
      return declared;
    }
  }
  return undefined;
}

function assertSupportedRef(
  persona: LoadedPersona,
  ref: string,
  target: SupportedTarget,
  mode: RenderMode,
): void {
  const { kind } = splitRef(ref);
  if (kind === 'model') {
    throw invalidConfig('model resources are expressed with the persona "model" key', {
      subject: persona.path,
    });
  }
  if (!(SUPPORTED_RESOURCE_KINDS as readonly string[]).includes(kind)) {
    throw invalidConfig(`unknown resource kind "${kind}"`, {
      subject: persona.path,
      action: `a resource reference names one of: ${SUPPORTED_RESOURCE_KINDS.join(', ')}`,
    });
  }
  if (target === 'claudecode' && (OPENCODE_WORKSPACE_KINDS as readonly string[]).includes(kind)) {
    throw invalidConfig(`the ${kind} resource kind is not carried by ${target} in this slice`, {
      subject: persona.path,
      action: `render this source for the opencode target, or remove the ${kind} reference`,
    });
  }
  // A workspace kind in agent mode has no per-recipient record, no opt-out and
  // no honest warning: a workspace emission would give every persona the
  // declarer's resource. Profile mode is the only mode that carries it, and its
  // absence is a refusal, never a silent workspace-wide emission.
  if (
    mode === MODE_AGENT &&
    isOpencodeTarget(target) &&
    (OPENCODE_WORKSPACE_KINDS as readonly string[]).includes(kind)
  ) {
    const { id } = splitRef(ref);
    throw invalidConfig(
      `${kind}/${id} is declared by persona ${persona.id} and requires profile mode on ${target}`,
      {
        subject: persona.path,
        action: `set targets.${target}.active to this persona (or pass --persona <id>) to run profile mode, or remove the reference`,
      },
    );
  }
}

function addResource(resources: Map<string, ResolvedResource>, resource: ResolvedResource): void {
  const key = `${resource.kind}/${resource.id}`;
  const existing = resources.get(key);
  if (existing === undefined) {
    resources.set(key, resource);
    return;
  }
  if (existing.sha256 !== resource.sha256) {
    throw conflict(`two sources disagree on ${key}`, {
      subject: existing.path,
      action: `the same (kind, id) is also declared in ${resource.path}; their content differs`,
    });
  }
  // Identical content is deduplicated and attributed to the most derived persona.
  resources.set(key, resource);
}

/** Sorted canonically: resource-kind order, then codepoint id. */
function sortResources(resources: ResolvedResource[]): ResolvedResource[] {
  return [...resources].sort((a, b) => {
    const byKind = (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99);
    return byKind === 0 ? compareCodepoints(a.id, b.id) : byKind;
  });
}

/**
 * Why OpenCode cannot carry this hook, or `undefined` when it can. Measured at
 * rulesync 43.14.0: `session-end` has no OpenCode event, and a matcher is
 * honoured only on the tool events (`preToolUse`/`postToolUse`).
 */
function hookProblem(hook: ResolvedHook): string | undefined {
  if (hook.phase === 'session-end') {
    return 'OpenCode has no session-end event';
  }
  if (hook.matcher !== undefined && hook.phase !== 'before-tool' && hook.phase !== 'after-tool') {
    return `OpenCode honours a matcher on tool events only, not on ${hook.phase}`;
  }
  return undefined;
}

function resolveOne(
  persona: LoadedPersona,
  chain: LoadedPersona[],
  byKind: {
    rules: Map<string, RuleResource>;
    permissions: Map<string, PermissionResource>;
    mcp: Map<string, McpResource>;
    skills: Map<string, SkillResource>;
    commands: Map<string, CommandResource>;
    hooks: Map<string, HookResource>;
  },
  config: Config,
  target: SupportedTarget,
  mode: RenderMode,
): ResolvedPersona {
  const model = resolveModel(chain, config, target);
  const personaMode = resolveMode(chain);
  const resources = new Map<string, ResolvedResource>();
  const permissions = emptyResolvedPermissions();
  const warnings: Warning[] = [];
  const seenRefs = new Set<string>();

  // Claude Code models one agent per file and has no primary/subagent axis, so
  // a declared mode has no representation there. The declaration is still
  // valid; dropping it silently would hide that the source asked for something
  // the target cannot do. The warning names both the persona and the target,
  // and the emitted file carries no `mode` key at all.
  if (target === 'claudecode' && personaMode !== undefined) {
    warnings.push(
      warning({
        code: 'W117_PERSONA_MODE_IGNORED',
        persona: persona.id,
        target,
        message: `persona "${persona.id}" declares mode "${personaMode}", which claudecode cannot carry: Claude Code has no primary/subagent mode, so no mode key is written`,
      }),
    );
  }

  const missing = (kind: string, id: string, contributor: LoadedPersona): never => {
    const dirs: Record<string, string> = {
      rule: 'rules',
      permission: 'permissions',
      mcp: 'mcp',
      skill: 'skills',
      command: 'commands',
      hook: 'hooks',
    };
    throw invalidConfig(`unknown ${kind} "${id}"`, {
      subject: contributor.path,
      action: `add the resource under .farna/resources/${dirs[kind] ?? kind}/`,
    });
  };

  for (const contributor of chain) {
    for (const ref of contributor.resources) {
      assertSupportedRef(contributor, ref, target, mode);
      const { kind, id } = splitRef(ref);
      const key = `${kind}/${id}`;
      const repeated = seenRefs.has(key);
      seenRefs.add(key);

      if (kind === 'rule') {
        const rule = byKind.rules.get(id) ?? missing('rule', id, contributor);
        addResource(resources, {
          kind: 'rule',
          id: rule.id,
          displayName: rule.displayName,
          body: rule.body,
          sha256: sha256Hex(rule.body),
          path: rule.path,
          fromPersona: contributor.id,
        });
        continue;
      }
      if (kind === 'permission') {
        const permission = byKind.permissions.get(id) ?? missing('permission', id, contributor);
        if (permission.allowlist === true && isOpencodeTarget(target)) {
          throw invalidConfig(
            `a permission resource opts into a tool allow-list, which the ${target} target cannot express`,
            {
              subject: permission.path,
              action: `remove "allowlist" or render this persona for claudecode; ${target} permission records are a deny-list`,
            },
          );
        }
        addResource(resources, {
          kind: 'permission',
          id: permission.id,
          sha256: permissionResourceDigest(
            permission.tools,
            permission.patterns,
            permission.allowlist,
          ),
          path: permission.path,
          fromPersona: contributor.id,
        });
        if (!repeated) {
          const contribution: PermissionContribution = {
            id: permission.id,
            tools: permission.tools,
            patterns: permission.patterns ?? {},
            allowlist: permission.allowlist,
          };
          mergePermission(permissions, contribution, {
            persona: persona.id,
            target,
            warnings,
          });
        }
        continue;
      }
      if (kind === 'mcp') {
        const server = byKind.mcp.get(id) ?? missing('mcp', id, contributor);
        addResource(resources, {
          kind: 'mcp',
          id: server.id,
          server: server.server,
          sha256: server.sha256,
          path: server.path,
          fromPersona: contributor.id,
        });
        continue;
      }
      if (kind === 'skill') {
        const skill = byKind.skills.get(id) ?? missing('skill', id, contributor);
        addResource(resources, {
          kind: 'skill',
          id: skill.id,
          description: skill.description,
          body: skill.body,
          files: skill.files,
          sha256: skill.sha256,
          path: skill.path,
          fromPersona: contributor.id,
        });
        continue;
      }
      if (kind === 'command') {
        const command = byKind.commands.get(id) ?? missing('command', id, contributor);
        addResource(resources, {
          kind: 'command',
          id: command.id,
          ...(command.description === undefined ? {} : { description: command.description }),
          body: command.body,
          sha256: command.sha256,
          path: command.path,
          fromPersona: contributor.id,
        });
        continue;
      }
      const hook = byKind.hooks.get(id) ?? missing('hook', id, contributor);
      addResource(resources, {
        kind: 'hook',
        id: hook.id,
        phase: hook.phase,
        ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
        command: hook.command,
        sha256: hook.sha256,
        path: hook.path,
        fromPersona: contributor.id,
      });
    }
  }

  const sortedResources = sortResources([...resources.values()]);
  const resolvedRules = sortedResources.filter(
    (resource): resource is ResolvedRule => resource.kind === 'rule',
  );
  const resolvedMcp = sortedResources.filter(
    (resource): resource is ResolvedMcp => resource.kind === 'mcp',
  );
  const resolvedSkills = sortedResources.filter(
    (resource): resource is ResolvedSkill => resource.kind === 'skill',
  );
  const resolvedCommands = sortedResources.filter(
    (resource): resource is ResolvedCommand => resource.kind === 'command',
  );
  const resolvedHooks: ResolvedHookOutcome[] = sortedResources
    .filter((resource): resource is ResolvedHook => resource.kind === 'hook')
    .map((hook) => {
      const reason = hookProblem(hook);
      return reason === undefined
        ? { ...hook, carried: true }
        : { ...hook, carried: false, reason };
    });
  // A hook the target cannot represent is a real loss, never a silent omission.
  // `hook` is a boundary capability, so the loss is HIGH. This is reachable only
  // in profile mode: agent mode refuses a hook reference before attribution.
  for (const hook of resolvedHooks) {
    if (hook.carried) {
      continue;
    }
    warnings.push(
      warning({
        code: 'W101_CAPABILITY_DROPPED',
        persona: persona.id,
        target,
        capability: 'hook',
        severity: 'high',
        message: `hook "${hook.id}" is not carried by ${target}: ${hook.reason ?? 'no matching event'}`,
      }),
    );
  }

  const mapped =
    target === 'claudecode'
      ? mapPermissions(permissions, { persona: persona.id, target })
      : undefined;
  const mappedOpencode = isOpencodeTarget(target)
    ? mapOpencodePermissions(permissions, { persona: persona.id, target })
    : undefined;
  if (mapped !== undefined) {
    warnings.push(...mapped.warnings);
  }
  if (mappedOpencode !== undefined) {
    warnings.push(...mappedOpencode.warnings);
  }

  const digest = sha256Hex(
    canonicalJson(
      sortedResources.map((resource) => ({
        kind: resource.kind,
        id: resource.id,
        sha256: resource.sha256,
        fromPersona: resource.fromPersona,
      })),
    ),
  );

  return {
    id: persona.id,
    displayName: persona.displayName,
    purpose: persona.purpose,
    ...(persona.extends === undefined ? {} : { extends: persona.extends }),
    chain: chain.map((entry) => entry.id),
    ...(personaMode === undefined ? {} : { mode: personaMode }),
    rules: resolvedRules,
    mcp: resolvedMcp,
    skills: resolvedSkills,
    commands: resolvedCommands,
    hooks: resolvedHooks,
    resources: sortedResources,
    permissions,
    claude: {
      allow: mapped?.entries.allow ?? [],
      deny: mapped?.entries.deny ?? [],
      allowlist: mapped?.allowlist ?? false,
    },
    opencode: {
      permission: mappedOpencode?.source ?? [],
      records: mappedOpencode?.records ?? [],
    },
    ...(model === undefined ? {} : { model }),
    path: persona.path,
    digest,
    permissionDigest: permissionDigest(permissions, mapped?.allowlist ?? false),
    warnings: sortWarnings(warnings),
  };
}

function unionAcrossPersonas<T extends { id: string; sha256: string }>(
  kind: string,
  personas: ResolvedPersona[],
  select: (persona: ResolvedPersona) => T[],
): T[] {
  const byId = new Map<string, T>();
  for (const persona of personas) {
    for (const resource of select(persona)) {
      const existing = byId.get(resource.id);
      if (existing === undefined) {
        byId.set(resource.id, resource);
        continue;
      }
      if (existing.sha256 !== resource.sha256) {
        throw conflict(`two personas disagree on ${kind}/${resource.id}`, {
          subject: resource.id,
        });
      }
    }
  }
  return [...byId.values()].sort((a, b) => compareCodepoints(a.id, b.id));
}

/**
 * Resolve every persona's composition chain into its resource set. The base
 * persona's rules, permissions and workspace resources are unioned in; the
 * stricter permission value wins; two different models are a conflict, never a
 * silent override.
 *
 * The target's mode is computed here, never chosen by a heuristic:
 *
 * - `targets.<target>.active` (or the `--persona` override) selects profile
 *   mode, makes exactly that persona live, and refuses F001 when the persona or
 *   the target's profile support is missing;
 * - otherwise the target is in agent mode and every persona is live.
 *
 * In profile mode only the live persona's artefacts and workspace resources are
 * returned, so `materialise` and the containment gate cannot emit or accept
 * another persona's resources: the isolation is structural, not a filter applied
 * later. Every persona is still resolved, so a broken declaration anywhere in
 * the source is reported; only emission is scoped to the live persona.
 */
export function resolveSource(
  source: SourceTree,
  config: Config,
  selection: SourceSelection = {},
): ResolvedSource {
  const target = configuredTarget(config);
  const configuredActive = config.targets[target]?.active;
  const requested = selection.persona ?? configuredActive;
  const mode: RenderMode = requested === undefined ? MODE_AGENT : MODE_PROFILE;
  const active = requested ?? null;
  // The subject names the thing the user must edit: the flag they passed, or
  // the config field that selected the persona.
  const selectionSubject = selection.persona !== undefined ? '--persona' : CONFIG_PATH;

  const sourceWarnings = source.warnings.map((entry) =>
    warning({
      code: entry.code,
      persona: SOURCE_WARNING_SUBJECT,
      target,
      ...(entry.capability === undefined ? {} : { capability: entry.capability }),
      message: entry.message,
    }),
  );
  const byId = new Map(source.personas.map((persona) => [persona.id, persona]));

  // The committed selection is validated even when `--persona` overrides it: a
  // `targets.<target>.active` that names no persona is a broken config, and the
  // flag must not mask it. The user commits this value; a run that ignores it
  // leaves the next run (without the flag) broken with no warning here.
  if (configuredActive !== undefined && !byId.has(configuredActive)) {
    throw invalidConfig(`targets.${target}.active "${configuredActive}" names no persona`, {
      subject: CONFIG_PATH,
      action: 'declare the persona under .farna/personas/, or remove the active key',
    });
  }

  if (active !== null) {
    if (!targetSupportsProfile(target)) {
      throw invalidConfig(`the ${target} target does not support profile mode`, {
        subject: selectionSubject,
        action: `remove the active persona for ${target}; profile mode is supported for: ${PROFILE_TARGETS.join(', ')}`,
      });
    }
    if (!byId.has(active)) {
      throw invalidConfig(`active persona "${active}" names no persona on ${target}`, {
        subject: selectionSubject,
        action: `declare the persona under .farna/personas/ for ${target}, or choose one that exists`,
      });
    }
  }

  const byKind = {
    rules: new Map(source.rules.map((rule) => [rule.id, rule])),
    permissions: new Map(source.permissions.map((permission) => [permission.id, permission])),
    mcp: new Map(source.mcp.map((server) => [server.id, server])),
    skills: new Map(source.skills.map((skill) => [skill.id, skill])),
    commands: new Map(source.commands.map((command) => [command.id, command])),
    hooks: new Map(source.hooks.map((hook) => [hook.id, hook])),
  };
  const resolved = source.personas.map((persona) =>
    resolveOne(persona, resolveChain(persona, byId), byKind, config, target, mode),
  );
  const notLive =
    active === null
      ? []
      : resolved
          .map((persona) => persona.id)
          .filter((id) => id !== active)
          .sort(compareCodepoints);
  // Profile mode is forced only when the **live** persona declares a boundary
  // capability the target carries at the workspace level and nowhere else.
  // An inactive persona's `mcp` or `hook` does not force the mode: it is not
  // emitted, so warning that the selection was forced would blame a declaration
  // that is not in the profile. Otherwise the selection is a choice, and every
  // other persona is silently not live unless the run says so: that is W109, at
  // info severity.
  const forcingScope = active === null ? resolved : resolved.filter((p) => p.id === active);
  const forced = forcingScope.some((persona) =>
    persona.resources.some((resource) =>
      (PROFILE_FORCING_KINDS as readonly string[]).includes(resource.kind),
    ),
  );
  // The message describes the resolved state, not the invocation: the same
  // source and config must produce the same lockfile whether the persona came
  // from `active` or from `--persona`, or `check` would report drift for an
  // identical selection.
  const profileWarnings =
    mode === MODE_PROFILE && !forced
      ? [
          warning({
            code: 'W109_PROFILE_BY_CHOICE',
            persona: active ?? SOURCE_WARNING_SUBJECT,
            target,
            message: `profile mode is active for ${target}${active === null ? '' : ` as ${active}`}, but ${active === null ? 'no persona' : 'the live persona'} declares no capability that requires it; agent mode is the default${
              notLive.length === 0
                ? ''
                : `, and ${notLive.join(', ')} ${notLive.length === 1 ? 'is' : 'are'} not live`
            }`,
          }),
        ]
      : [];
  const personas = active === null ? resolved : resolved.filter((persona) => persona.id === active);
  if (active === null) {
    return {
      target,
      mode,
      active,
      notLive,
      personas,
      mcp: unionAcrossPersonas('mcp', personas, (persona) => persona.mcp),
      skills: unionAcrossPersonas('skill', personas, (persona) => persona.skills),
      commands: unionAcrossPersonas('command', personas, (persona) => persona.commands),
      hooks: unionAcrossPersonas('hook', personas, (persona) => persona.hooks),
      warnings: sortWarnings([
        ...sourceWarnings,
        ...personas.flatMap((persona) => persona.warnings),
      ]),
    };
  }
  const live = personas[0];
  if (personas.length !== 1 || live === undefined) {
    // Defensive: `active` was proven to name a persona above. Reaching here
    // means the source changed under the resolver, which must never be guessed.
    throw invalidConfig(`active persona "${active}" did not resolve to exactly one live persona`, {
      subject: selectionSubject,
    });
  }
  return {
    target,
    mode,
    active,
    notLive,
    personas,
    // Profile mode: the live persona's own resources, never a union across the
    // personas that are not live. Anything else would leak a resource the
    // workspace owner never declared.
    mcp: live.mcp,
    skills: live.skills,
    commands: live.commands,
    hooks: live.hooks,
    // Every resolved persona's source-derived warnings, not only the live
    // persona's: a warning carries its own `persona` and describes a
    // declaration that was validated, so dropping a non-live persona's W101 or
    // W112 would hide a real loss from the run that resolved it. The lockfile
    // records the same set, scoped by persona.
    warnings: sortWarnings([
      ...sourceWarnings,
      ...resolved.flatMap((persona) => persona.warnings),
      ...profileWarnings,
    ]),
  };
}
