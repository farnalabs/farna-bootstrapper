import type { Config } from '../config/schema.js';
import { DEFAULT_TARGET, MAX_EXTENDS_DEPTH, SUPPORTED_RESOURCE_KINDS } from '../core/constants.js';
import { conflict, invalidConfig } from '../core/errors.js';
import { canonicalJson, compareCodepoints, sha256Hex } from '../core/json.js';
import {
  emptyResolvedPermissions,
  mapPermissions,
  mergePermission,
  type PermissionContribution,
  permissionDigest,
  permissionResourceDigest,
  type ResolvedPermissions,
} from '../permissions/permissions.js';
import { sortWarnings, type Warning } from '../report/warnings.js';
import type {
  LoadedPersona,
  PermissionResource,
  RuleResource,
  SourceTree,
} from '../source/load.js';

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

export type ResolvedResource = ResolvedRule | ResolvedPermission;

export type ResolvedPersona = {
  id: string;
  displayName: string;
  purpose: string;
  /** The base persona id when this persona is composed. */
  extends?: string;
  /** The full composition chain, base first, this persona last. */
  chain: string[];
  rules: ResolvedRule[];
  /** Every resolved resource, rules before permissions, each sorted by id. */
  resources: ResolvedResource[];
  permissions: ResolvedPermissions;
  /** The exact Claude Code entries, already sorted and capitalised. */
  claude: { allow: string[]; deny: string[] };
  model?: string;
  path: string;
  /** Canonical digest of the persona's resolved resources. */
  digest: string;
  /** Canonical digest of the resolved permission map. */
  permissionDigest: string;
  warnings: Warning[];
};

export type ResolvedSource = {
  target: string;
  personas: ResolvedPersona[];
  warnings: Warning[];
};

const KIND_ORDER: Record<string, number> = { rule: 0, permission: 1 };

function splitRef(ref: string): { kind: string; id: string } {
  const separator = ref.indexOf('/');
  return { kind: ref.slice(0, separator), id: ref.slice(separator + 1) };
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

function resolveModelClass(modelClass: string, subject: string, config: Config): string {
  const mapping = config.models?.[modelClass];
  if (mapping === undefined) {
    throw invalidConfig(`model class "${modelClass}" is not declared in config.models`, {
      subject,
    });
  }
  const modelId = mapping[DEFAULT_TARGET];
  if (modelId === undefined) {
    throw invalidConfig(`model class "${modelClass}" has no "${DEFAULT_TARGET}" mapping`, {
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
function resolveModel(chain: LoadedPersona[], config: Config): string | undefined {
  const declared = chain
    .filter((persona) => persona.model !== undefined)
    .map((persona) => ({
      persona,
      modelClass: persona.model as string,
      modelId: resolveModelClass(persona.model as string, persona.path, config),
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

function assertSupportedRef(persona: LoadedPersona, ref: string): { kind: string; id: string } {
  const { kind, id } = splitRef(ref);
  if (!SUPPORTED_RESOURCE_KINDS.includes(kind as (typeof SUPPORTED_RESOURCE_KINDS)[number])) {
    throw invalidConfig(`resource kind "${kind}" is not implemented in this slice`, {
      subject: persona.path,
      action: 'this slice supports rule and permission references',
    });
  }
  if (kind === 'model') {
    throw invalidConfig('model resources are expressed with the persona "model" key', {
      subject: persona.path,
    });
  }
  return { kind, id };
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

/** Sorted canonically: rules before permissions, then by codepoint id. */
function sortResources(resources: ResolvedResource[]): ResolvedResource[] {
  return [...resources].sort((a, b) => {
    const byKind = (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99);
    return byKind === 0 ? compareCodepoints(a.id, b.id) : byKind;
  });
}

function resolveOne(
  persona: LoadedPersona,
  chain: LoadedPersona[],
  rulesById: Map<string, RuleResource>,
  permissionsById: Map<string, PermissionResource>,
  config: Config,
): ResolvedPersona {
  const model = resolveModel(chain, config);
  const resources = new Map<string, ResolvedResource>();
  const permissions = emptyResolvedPermissions();
  const warnings: Warning[] = [];
  const seenRefs = new Set<string>();

  for (const contributor of chain) {
    for (const ref of contributor.resources) {
      const { kind, id } = assertSupportedRef(contributor, ref);
      const key = `${kind}/${id}`;
      const repeated = seenRefs.has(key);
      seenRefs.add(key);
      if (kind === 'rule') {
        const rule = rulesById.get(id);
        if (rule === undefined) {
          throw invalidConfig(`unknown rule "${id}"`, {
            subject: contributor.path,
            action: 'add the rule file under .farna/resources/rules/',
          });
        }
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
      const permission = permissionsById.get(id);
      if (permission === undefined) {
        throw invalidConfig(`unknown permission "${id}"`, {
          subject: contributor.path,
          action: 'add the permission file under .farna/resources/permissions/',
        });
      }
      addResource(resources, {
        kind: 'permission',
        id: permission.id,
        sha256: permissionResourceDigest(permission.tools, permission.patterns),
        path: permission.path,
        fromPersona: contributor.id,
      });
      if (!repeated) {
        const contribution: PermissionContribution = {
          id: permission.id,
          tools: permission.tools,
          patterns: permission.patterns ?? {},
        };
        mergePermission(permissions, contribution, {
          persona: persona.id,
          target: DEFAULT_TARGET,
          warnings,
        });
      }
    }
  }

  const sortedResources = sortResources([...resources.values()]);
  const resolvedRules = sortedResources.filter(
    (resource): resource is ResolvedRule => resource.kind === 'rule',
  );
  const mapped = mapPermissions(permissions, { persona: persona.id, target: DEFAULT_TARGET });
  warnings.push(...mapped.warnings);

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
    rules: resolvedRules,
    resources: sortedResources,
    permissions,
    claude: mapped.entries,
    ...(model === undefined ? {} : { model }),
    path: persona.path,
    digest,
    permissionDigest: permissionDigest(permissions),
    warnings: sortWarnings(warnings),
  };
}

/**
 * Resolve every persona's composition chain into its resource set. The base
 * persona's rules and permissions are unioned in; the stricter permission value
 * wins; two different models are a conflict, never a silent override.
 */
export function resolveSource(source: SourceTree, config: Config): ResolvedSource {
  const byId = new Map(source.personas.map((persona) => [persona.id, persona]));
  const rulesById = new Map(source.rules.map((rule) => [rule.id, rule]));
  const permissionsById = new Map(
    source.permissions.map((permission) => [permission.id, permission]),
  );
  const personas = source.personas.map((persona) =>
    resolveOne(persona, resolveChain(persona, byId), rulesById, permissionsById, config),
  );
  return {
    target: DEFAULT_TARGET,
    personas,
    warnings: sortWarnings(personas.flatMap((persona) => persona.warnings)),
  };
}
