import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ResolvedSource, resolveSource } from '../compose/resolve.js';
import { loadConfig } from '../config/load.js';
import { LOCK_FILE, ROOT_DIR } from '../core/constants.js';
import { compareCodepoints } from '../core/json.js';
import { buildLockfile, type RenderedFile, serialiseLockfile } from '../lock/lockfile.js';
import { materialiseSourceTree } from '../materialise/source-tree.js';
import { loadSource } from '../source/load.js';
import { verifyRender } from '../verify/containment.js';
import type { RenderTarget } from './port.js';
import { withStage } from './stage.js';

export type PreparedRender = {
  source: ResolvedSource;
  /** Every managed file, repository-relative, sorted. Includes the lockfile. */
  files: RenderedFile[];
};

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
      target: 'claudecode',
      sourceRoot: stage.sourceRoot,
      outputRoot: stage.outputRoot,
    });
    await verifyRender(source, render, stage.outputRoot);

    const files: RenderedFile[] = [];
    for (const path of [...render.files].sort(compareCodepoints)) {
      files.push({ path, bytes: await readFile(join(stage.outputRoot, path), 'utf8') });
    }
    const lock = buildLockfile(source, renderer.identity(), files);
    files.push({ path: `${ROOT_DIR}/${LOCK_FILE}`, bytes: serialiseLockfile(lock) });
    files.sort((a, b) => compareCodepoints(a.path, b.path));
    return { source, files };
  });
}
