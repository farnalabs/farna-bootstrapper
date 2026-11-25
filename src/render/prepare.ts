import { type ResolvedSource, resolveSource, type SourceSelection } from '../compose/resolve.js';
import { loadConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { DEFAULT_TARGET, LOCK_PATH, type SupportedTarget } from '../core/constants.js';
import { rendererMismatch } from '../core/errors.js';
import { compareCodepoints } from '../core/json.js';
import {
  buildLockfile,
  type LockfileRenderer,
  type RenderedFile,
  serialiseLockfile,
} from '../lock/lockfile.js';
import { materialiseSourceTree, renderFeatures } from '../materialise/source-tree.js';
import { sortWarnings, type Warning, warning } from '../report/warnings.js';
import { sourceConfigDigest } from '../source/digest.js';
import { loadSource, type SourceTree } from '../source/load.js';
import { verifyRender } from '../verify/containment.js';
import { integrityRecordOf } from './identity.js';
import type { RendererIdentity, RenderTarget } from './port.js';
import { withStage } from './stage.js';
import {
  parseStructuredDocument,
  structuredOwnedDigest,
  structuredOwnedKeys,
} from './structured.js';

/**
 * The subject a renderer-level warning carries. A warning record is shaped per
 * persona, but an unverified integrity belongs to the renderer, not to any one
 * persona; angle brackets cannot collide with a valid persona id (`ID_RE`).
 */
const RENDERER_WARNING_SUBJECT = '<renderer>';

/**
 * Every configured target id, in codepoint order. The config schema admits one
 * target in this slice; the pipeline loops over this list anyway, so the
 * per-target path is the real path rather than a single-target special case.
 */
export function configuredTargets(config: Config): SupportedTarget[] {
  return (Object.keys(config.targets) as SupportedTarget[]).sort(compareCodepoints);
}

/** One target's resolved source and the verified bytes it produced. */
export type PreparedTarget = {
  source: ResolvedSource;
  /** Every managed file this target produced, repository-relative, sorted. Never the lockfile. */
  files: RenderedFile[];
  /** Source warnings plus any renderer-level warning, in the report's stable order. */
  warnings: Warning[];
};

export type PreparedRender = {
  /** One entry per configured target, in target-id order. */
  targets: PreparedTarget[];
  /** Every managed file across every target plus the lockfile, sorted. */
  files: RenderedFile[];
  /** Every target's warnings, in the report's stable order. */
  warnings: Warning[];
  /** Digest of the resolved config plus every persona and resource file. */
  configDigest: string;
};

/**
 * Record the ownership metadata of a structured file. The lockfile entry for
 * `opencode.jsonc` describes the owned subset, not the whole document, so the
 * lockfile stays source-derived and a user's own key never becomes drift.
 *
 * A generated document that carries none of the owned keys is recorded as a
 * whole file, without `shape`. A `structured` entry whose `ownedKeys` is empty
 * is refused by the lockfile schema, so stamping the shape would produce a
 * document this tool cannot read back.
 */
function annotateOwnership(file: RenderedFile): RenderedFile {
  const ownedKeys = structuredOwnedKeys(file.path);
  if (ownedKeys === undefined) {
    return file;
  }
  const document = parseStructuredDocument(file.bytes, file.path);
  const present = ownedKeys.filter((key) => Object.hasOwn(document, key));
  if (present.length === 0) {
    return file;
  }
  const digest = structuredOwnedDigest(document, present);
  return {
    ...file,
    shape: 'structured',
    ownedKeys: present,
    ownedSha256: digest.sha256,
    ownedSize: digest.size,
  };
}

/**
 * The `W114` warning, when the installed renderer's tarball integrity could not
 * be verified. The version check is independent of this: it has already run and
 * a mismatch is `F010`. The message names which lookup failed, so a reader never
 * has to guess between "no record at all" and "a record with no integrity".
 */
export function rendererIntegrityWarning(
  identity: RendererIdentity,
  target: string = DEFAULT_TARGET,
): Warning | undefined {
  const record = integrityRecordOf(identity);
  if (record.verified) {
    return undefined;
  }
  const subject = `${identity.name} ${identity.version}`;
  const detail =
    record.reason === 'no-integrity'
      ? `the npm lock record for ${subject} has no integrity`
      : `no npm lock record for ${subject} was found`;
  return warning({
    code: 'W114_RENDERER_INTEGRITY_UNVERIFIED',
    persona: RENDERER_WARNING_SUBJECT,
    target,
    message: `${detail}, so the installed renderer's tarball integrity could not be verified; the pinned version is still enforced`,
  });
}

/** The renderer-level warnings for one run. */
export function rendererWarnings(
  renderer: RenderTarget,
  target: string = DEFAULT_TARGET,
): Warning[] {
  const entry = rendererIntegrityWarning(renderer.identity(), target);
  return entry === undefined ? [] : [entry];
}

/**
 * The identity recorded in the lockfile. A renderer that pins its dependency
 * exposes the pin here, so the record is identical on every machine with the
 * same source; the installed package is still verified against it separately.
 */
export function recordedIdentity(renderer: RenderTarget): RendererIdentity {
  return renderer.recordedIdentity === undefined
    ? renderer.identity()
    : renderer.recordedIdentity();
}

/**
 * The lockfile's renderer record must carry an integrity. A renderer that
 * cannot name the tarball it pins is refused (F010) rather than recording a
 * version-only identity the reader would have to trust without a digest.
 */
function lockfileRenderer(renderer: RenderTarget): LockfileRenderer {
  const recorded = recordedIdentity(renderer);
  if (recorded.integrity === undefined) {
    throw rendererMismatch(
      `the renderer ${recorded.name} ${recorded.version} records no tarball integrity`,
      {
        subject: recorded.name,
        action: 'pin the renderer with a recorded integrity before generate records it',
      },
    );
  }
  return { name: recorded.name, version: recorded.version, integrity: recorded.integrity };
}

/**
 * The per-target half of the pipeline: resolve one target's source, then
 * materialise, render and verify it into its own disposable stage. It returns
 * the verified bytes and builds no lockfile. Nothing is written to the
 * repository here.
 *
 * The target is resolved through a config scoped to that one id, so the loop in
 * `prepareRender` is genuinely per target rather than passing the run's first
 * target each time.
 */
export async function prepareTarget(
  renderer: RenderTarget,
  config: Config,
  tree: SourceTree,
  target: SupportedTarget,
  selection: SourceSelection = {},
): Promise<PreparedTarget> {
  const scoped: Config = {
    ...config,
    targets: { [target]: config.targets[target] ?? {} },
  };
  const source = resolveSource(tree, scoped, selection);
  const warnings = sortWarnings([...source.warnings, ...rendererWarnings(renderer, source.target)]);

  return withStage(async (stage) => {
    await materialiseSourceTree(stage.sourceRoot, source);
    const render = await renderer.generate({
      target: source.target,
      stageRoot: stage.root,
      sourceRoot: stage.sourceRoot,
      outputRoot: stage.outputRoot,
      features: renderFeatures(source.target, source),
    });
    // One read per artefact: the bytes verification approved are the bytes
    // committed, never a second read of a stage a renderer could still touch.
    const verified = await verifyRender(source, render, stage.outputRoot);

    const files: RenderedFile[] = [...verified.entries()]
      .map(([path, bytes]) => annotateOwnership({ path, bytes }))
      .sort((a, b) => compareCodepoints(a.path, b.path));
    return { source, files, warnings };
  });
}

/**
 * The whole read → materialise → render → verify pipeline over every configured
 * target. Nothing is written to the repository here; this returns the bytes that
 * verification approved.
 *
 * Every target renders into its own stage and passes its own containment gate.
 * Only then is the run-level lockfile assembled and appended, so a failure in
 * any target leaves the tree untouched.
 */
export async function prepareRender(
  repoRoot: string,
  renderer: RenderTarget,
  selection: SourceSelection = {},
): Promise<PreparedRender> {
  const config = await loadConfig(repoRoot);
  const tree = await loadSource(repoRoot);
  // Every source file, including a persona that is not live: an edit to a
  // declaration no mode renders still has to be visible to `check`.
  const configDigest = await sourceConfigDigest(repoRoot, config);

  const targets: PreparedTarget[] = [];
  for (const target of configuredTargets(config)) {
    targets.push(await prepareTarget(renderer, config, tree, target, selection));
  }

  // The lockfile records source-derived state only. A renderer-level warning
  // such as `W114` is runtime verification evidence about THIS machine, so it
  // is reported by the command but never written into the byte-compared
  // artefact: a verified and an unverified machine with the same source must
  // produce the same `.farna/lock.json`.
  const lock = buildLockfile(
    lockfileRenderer(renderer),
    targets.map((target) => ({ source: target.source, files: target.files })),
    sortWarnings(targets.flatMap((target) => target.source.warnings)),
    { configDigest },
  );
  const files: RenderedFile[] = targets.flatMap((target) => target.files);
  files.push({ path: LOCK_PATH, bytes: serialiseLockfile(lock) });
  files.sort((a, b) => compareCodepoints(a.path, b.path));

  return {
    targets,
    files,
    warnings: sortWarnings(targets.flatMap((target) => target.warnings)),
    configDigest,
  };
}
