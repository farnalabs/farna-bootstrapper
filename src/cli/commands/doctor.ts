import { type ResolvedPersona, resolveSource } from '../../compose/resolve.js';
import { loadConfig } from '../../config/load.js';
import {
  type Capability,
  CONFIG_PATH,
  type PersonaMode,
  type RenderMode,
  ROOT_DIR,
  type SupportedTarget,
} from '../../core/constants.js';
import type { Warning } from '../../report/warnings.js';
import { loadSource } from '../../source/load.js';

/** One resolved resource with the attribution `doctor` prints. */
export type DoctorResource = {
  kind: Capability;
  id: string;
  path: string;
  fromPersona: string;
  /** 0 for the persona itself, 1 for its immediate base, and so on. */
  rank: number;
};

export type DoctorPersona = {
  id: string;
  displayName: string;
  purpose: string;
  /** The composition chain, base first. */
  chain: string[];
  mode: PersonaMode | null;
  model: string | null;
  resources: DoctorResource[];
};

/**
 * One validation this run performed. `doctor` fails at the first error, so a
 * check appears here only when it ran and did not fail; a report never claims
 * a check it did not reach.
 */
export type DoctorCheck = {
  name: string;
  detail: string;
};

export type DoctorResult = {
  ok: true;
  target: SupportedTarget;
  mode: RenderMode;
  activePersona: string | null;
  notLive: string[];
  configPath: string;
  counts: {
    /** Personas declared in the source, live or not. */
    personas: number;
    /** Personas this target emits in the selected mode. */
    live: number;
    resourceReferences: number;
    modelClasses: number;
    warnings: number;
  };
  checks: DoctorCheck[];
  personas: DoctorPersona[];
  warnings: Warning[];
};

function doctorPersona(persona: ResolvedPersona): DoctorPersona {
  return {
    id: persona.id,
    displayName: persona.displayName,
    purpose: persona.purpose,
    chain: persona.chain,
    mode: persona.mode ?? null,
    model: persona.model ?? null,
    resources: persona.resources.map((resource) => ({
      kind: resource.kind,
      id: resource.id,
      path: resource.path,
      fromPersona: resource.fromPersona,
      // Depth from the reported persona: its own resources are rank 0, an
      // immediate base's are rank 1, and so on.
      rank: persona.chain.length - 1 - persona.chain.indexOf(resource.fromPersona),
    })),
  };
}

/**
 * Validate a `.farna` source without rendering or writing.
 *
 * The read → resolve half of `prepareRender` is reused wholesale: the config
 * loader, the source loader and the resolver are the same ones `generate` and
 * `check` run, so `doctor` cannot accept a source they refuse. Only the
 * materialise → render → verify half is skipped, because a report that renders
 * bytes would need the renderer and could mask a source error behind a render
 * error.
 *
 * A failure throws the loader's or resolver's own `FarnaError`, so the exit
 * code and the code are the ones `generate` would produce for the same source.
 */
export async function runDoctor(repoRoot: string): Promise<DoctorResult> {
  const config = await loadConfig(repoRoot);
  const tree = await loadSource(repoRoot);
  const source = resolveSource(tree, config);

  const modelClasses = Object.keys(config.models ?? {}).length;
  const personas = source.personas.map(doctorPersona);
  const resourceReferences = personas.reduce(
    (total, persona) => total + persona.resources.length,
    0,
  );
  const categories = new Set<string>();
  let patterns = 0;
  for (const persona of source.personas) {
    for (const key of Object.keys(persona.permissions.values)) {
      categories.add(key);
    }
    for (const bucket of Object.values(persona.permissions.patterns)) {
      patterns += Object.keys(bucket).length;
    }
  }

  const modeDetail =
    source.mode === 'profile'
      ? `${source.target}, profile mode, active ${source.active ?? '<none>'}`
      : `${source.target}, agent mode, every persona live`;

  return {
    ok: true,
    target: source.target,
    mode: source.mode,
    activePersona: source.active,
    notLive: source.notLive,
    configPath: CONFIG_PATH,
    counts: {
      personas: tree.personas.length,
      live: source.personas.length,
      resourceReferences,
      modelClasses,
      warnings: source.warnings.length,
    },
    checks: [
      { name: 'config schema', detail: CONFIG_PATH },
      { name: 'source tree and paths', detail: ROOT_DIR },
      {
        name: 'personas and extends chains',
        detail: `${tree.personas.length} persona(s) resolved, no cycle`,
      },
      {
        name: 'resource references',
        detail: `${resourceReferences} reference(s) across ${source.personas.length} live persona(s)`,
      },
      {
        name: 'model map',
        detail:
          modelClasses === 0
            ? 'no model class declared'
            : `${modelClasses} model class(es) resolve for ${source.target}`,
      },
      { name: 'target and profile mode', detail: modeDetail },
      {
        name: 'permission categories and patterns',
        detail: `${categories.size} categor(ies), ${patterns} pattern(s)`,
      },
      {
        name: 'secret references',
        detail: 'MCP credential fields are fromEnv or header references only',
      },
    ],
    personas,
    warnings: source.warnings,
  };
}
