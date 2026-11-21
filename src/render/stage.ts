import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathUnsafe } from '../core/errors.js';

export type Stage = {
  /** Canonical path to the stage root. */
  root: string;
  /** `root/src` — the rulesync source tree. */
  sourceRoot: string;
  /** `root/out` — the renderer output root. */
  outputRoot: string;
};

export type RemoveStage = (
  path: string,
  options: { recursive: boolean; force: boolean },
) => Promise<void>;

const defaultRemoveStage: RemoveStage = async (path, options) => {
  await rm(path, options);
};

async function canonicalTmpRoot(): Promise<string> {
  // Canonicalise once: on macOS /var is a symlink to /private/var.
  return realpath(tmpdir());
}

function assertInside(root: string, candidate: string): void {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (candidate !== root && !candidate.startsWith(prefix)) {
    throw pathUnsafe('refusing to remove a path outside the temporary root', {
      subject: candidate,
    });
  }
}

/**
 * Remove the stage this process created. Teardown is the last line of the
 * diagnostic path: a cleanup failure is reported as a warning naming the
 * leftover path and never replaces the error that was already in flight.
 */
export async function cleanupStage(
  root: string,
  tmpRoot: string,
  removeStage: RemoveStage = defaultRemoveStage,
): Promise<void> {
  try {
    assertInside(tmpRoot, root);
    await removeStage(root, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `farna-bootstrapper: warning: could not remove temporary stage ${root}: ${message}\n`,
    );
  }
}

/**
 * Create a disposable stage and always attempt to remove it. The stage is the
 * only place a renderer is allowed to write before verification passes.
 */
export async function withStage<T>(
  run: (stage: Stage) => Promise<T>,
  removeStage: RemoveStage = defaultRemoveStage,
): Promise<T> {
  const tmpRoot = await canonicalTmpRoot();
  const created = await mkdtemp(join(tmpRoot, 'farna-bootstrapper-'));
  const root = await realpath(created);
  const sourceRoot = join(root, 'src');
  const outputRoot = join(root, 'out');
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  try {
    return await run({ root, sourceRoot, outputRoot });
  } finally {
    // This is the one recursive delete in src/, and it can only ever target a
    // mkdtemp directory we own.
    await cleanupStage(root, tmpRoot, removeStage);
  }
}
