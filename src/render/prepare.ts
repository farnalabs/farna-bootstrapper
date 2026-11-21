import { type ResolvedSource, resolveSource } from '../compose/resolve.js';
import { loadConfig } from '../config/load.js';
import { DEFAULT_TARGET, LOCK_PATH } from '../core/constants.js';
import { rendererMismatch } from '../core/errors.js';
import { compareCodepoints } from '../core/json.js';
import {
  buildLockfile,
  type LockfileRenderer,
  type RenderedFile,
  serialiseLockfile,
} from '../lock/lockfile.js';
import { materialiseSourceTree } from '../materialise/source-tree.js';
import { loadSource } from '../source/load.js';
import { verifyRender } from '../verify/containment.js';
import type { RendererIdentity, RenderTarget } from './port.js';
import { withStage } from './stage.js';

export type PreparedRender = {
  source: ResolvedSource;
  /** Every managed file, repository-relative, sorted. Includes the lockfile. */
  files: RenderedFile[];
};

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
 * The whole read → materialise → render → verify pipeline. Nothing is written
 * to the repository here; this returns the bytes that verification approved.
 */
export async function prepareRender(
  repoRoot: string,
  renderer: RenderTarget,
): Promise<PreparedRender> {
  const config = await loadConfig(repoRoot);
  const source = resolveSource(await loadSource(repoRoot), config);

  return withStage(async (stage) => {
    await materialiseSourceTree(stage.sourceRoot, source);
    const render = await renderer.generate({
      target: DEFAULT_TARGET,
      stageRoot: stage.root,
      sourceRoot: stage.sourceRoot,
      outputRoot: stage.outputRoot,
    });
    // One read per artefact: the bytes verification approved are the bytes
    // committed, never a second read of a stage a renderer could still touch.
    const verified = await verifyRender(source, render, stage.outputRoot);

    const files: RenderedFile[] = [...verified.entries()]
      .map(([path, bytes]) => ({ path, bytes }))
      .sort((a, b) => compareCodepoints(a.path, b.path));
    const lock = buildLockfile(source, lockfileRenderer(renderer), files);
    files.push({ path: LOCK_PATH, bytes: serialiseLockfile(lock) });
    files.sort((a, b) => compareCodepoints(a.path, b.path));
    return { source, files };
  });
}
