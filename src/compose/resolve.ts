import type { Config } from '../config/schema.js';
import { DEFAULT_TARGET, SUPPORTED_RESOURCE_KINDS } from '../core/constants.js';
import { invalidConfig } from '../core/errors.js';
import { canonicalJson, compareCodepoints, sha256Hex } from '../core/json.js';
import type { LoadedPersona, SourceTree } from '../source/load.js';

export type ResolvedRule = {
  id: string;
  displayName: string;
  body: string;
  sha256: string;
  path: string;
};

export type ResolvedPersona = {
  id: string;
  displayName: string;
  purpose: string;
  rules: ResolvedRule[];
  model?: string;
  path: string;
  /** Canonical digest of the persona's resolved resources. */
  digest: string;
};

export type ResolvedSource = {
  target: string;
  personas: ResolvedPersona[];
};

function resolveRules(
  persona: LoadedPersona,
  rulesById: Map<string, SourceTree['rules'][number]>,
): ResolvedRule[] {
  const resolved: ResolvedRule[] = [];
  for (const ref of persona.resources) {
    const separator = ref.indexOf('/');
    const kind = ref.slice(0, separator);
    const id = ref.slice(separator + 1);
    if (!SUPPORTED_RESOURCE_KINDS.includes(kind as (typeof SUPPORTED_RESOURCE_KINDS)[number])) {
      throw invalidConfig(`resource kind "${kind}" is not implemented in this slice`, {
        subject: persona.path,
        action: 'this slice supports rule references only',
      });
    }
    if (kind === 'model') {
      // Model resources are expressed as the persona's `model` class in this slice.
      throw invalidConfig('model resources are expressed with the persona "model" key', {
        subject: persona.path,
      });
    }
    const rule = rulesById.get(id);
    if (rule === undefined) {
      throw invalidConfig(`unknown rule "${id}"`, {
        subject: persona.path,
        action: 'add the rule file under .farna/resources/rules/',
      });
    }
    resolved.push({
      id: rule.id,
      displayName: rule.displayName,
      body: rule.body,
      sha256: sha256Hex(rule.body),
      path: rule.path,
    });
  }
  return resolved.sort((a, b) => compareCodepoints(a.id, b.id));
}

function resolveModel(persona: LoadedPersona, config: Config): string | undefined {
  if (persona.model === undefined) {
    return undefined;
  }
  const mapping = config.models?.[persona.model];
  if (mapping === undefined) {
    throw invalidConfig(`model class "${persona.model}" is not declared in config.models`, {
      subject: persona.path,
    });
  }
  const modelId = mapping[DEFAULT_TARGET];
  if (modelId === undefined) {
    throw invalidConfig(`model class "${persona.model}" has no "${DEFAULT_TARGET}" mapping`, {
      subject: persona.path,
    });
  }
  return modelId;
}

/**
 * Resolve each persona's resource references. In this slice composition and
 * `extends` do not exist: one persona is one declaration.
 */
export function resolveSource(source: SourceTree, config: Config): ResolvedSource {
  const rulesById = new Map(source.rules.map((rule) => [rule.id, rule]));
  const personas = source.personas.map((persona) => {
    const rules = resolveRules(persona, rulesById);
    const model = resolveModel(persona, config);
    const digest = sha256Hex(
      canonicalJson(
        rules.map((rule) => ({
          kind: 'rule',
          id: rule.id,
          sha256: rule.sha256,
        })),
      ),
    );
    return {
      id: persona.id,
      displayName: persona.displayName,
      purpose: persona.purpose,
      rules,
      ...(model === undefined ? {} : { model }),
      path: persona.path,
      digest,
    };
  });
  return { target: DEFAULT_TARGET, personas };
}
