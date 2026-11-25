import { type ResolvedSource, resolveSource, type SourceSelection } from '../compose/resolve.js';
import { loadConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { configuredTargets } from '../config/targets.js';
import {
  DEFAULT_TARGET,
  LOCK_PATH,
  type SupportedTarget,
  targetSupportsProfile,
} from '../core/constants.js';
import { rendererMismatch } from '../core/errors.js';
import { compareCodepoints, sha256Hex } from '../core/json.js';
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
import { assertNoRegionMarkers, normaliseRegionBody, regionIdOf } from './region.js';
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
 * The subject an invocation-level warning carries. `--persona` is a flag, not a
 * declaration any persona made, so `W118` has no persona to name; the sentinel
 * keeps that honest and, like `<renderer>`, cannot collide with a persona id.
 */
const PERSONA_FLAG_WARNING_SUBJECT = '<flag>';

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
 * Record the ownership metadata of a structured or region file. The lockfile
 * entry for either describes the owned subset, not the whole document, so the
 * lockfile stays source-derived and a user's own key or prose never becomes
 * drift.
 *
 * A region file's rendered bytes are the **body** to write, and the digest
 * describes that body only. The markers are not in the renderer's output: they
 * belong to the target file, and the merge writes them. A rendered body that
 * already carries one is refused, because the merged file would then nest a
 * region this tool cannot read back.
 *
 * A generated document that carries none of the owned keys is recorded as a
 * whole file, without `shape`. A `structured` entry whose `ownedKeys` is empty
 * is refused by the lockfile schema, so stamping the shape would produce a
 * document this tool cannot read back.
 */
export function annotateOwnership(file: RenderedFile): RenderedFile {
  const regionId = regionIdOf(file.path);
  if (regionId !== undefined) {
    assertNoRegionMarkers(file.bytes, file.path);
    const body = normaliseRegionBody(file.bytes);
    return {
      ...file,
      bytes: body,
      shape: 'region',
      regionId,
      ownedSha256: sha256Hex(body),
      ownedSize: Buffer.byteLength(body),
    };
  }
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
  // `--persona` selects profile mode only on a target that supports it. When
  // this config also names a profile-capable target, a target that does not
  // support profile mode (claudecode) stays in agent mode and the run reports
  // that the flag did not apply to it, once per such target. With no
  // profile-capable target configured the flag is passed through and refused
  // by the resolver, exactly as a claudecode-only config always has been.
  const profileCapableConfigured = configuredTargets(config).some(targetSupportsProfile);
  const requested = selection.persona;
  const flagIgnored =
    requested !== undefined && !targetSupportsProfile(target) && profileCapableConfigured;
  const source = resolveSource(tree, scoped, flagIgnored ? {} : selection);
  // W118 is invocation-level, not source-derived: it is reported by the
  // command and never reaches the lockfile, which `prepareRender` builds from
  // `source.warnings` only.
  const flagWarnings: Warning[] =
    requested !== undefined && flagIgnored
      ? [
          warning({
            code: 'W118_PERSONA_FLAG_NOT_APPLIED',
            persona: PERSONA_FLAG_WARNING_SUBJECT,
            target,
            message: `--persona "${requested}" was not applied to the ${target} target: it does not support profile mode, so it stays in agent mode with every persona live`,
          }),
        ]
      : [];
  const warnings = sortWarnings([
    ...source.warnings,
    ...rendererWarnings(renderer, source.target),
    ...flagWarnings,
  ]);

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
