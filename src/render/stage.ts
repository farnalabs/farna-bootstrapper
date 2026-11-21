import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathUnsafe, renderFailed } from '../core/errors.js';
import { describeFsError } from '../core/fs.js';
import { isPathInside } from '../core/paths.js';

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

/** The filesystem calls a stage makes; the seam makes an early failure testable. */
export type StageOperations = {
  tmpdir: () => string;
  realpath: (path: string) => Promise<string>;
  mkdtemp: (prefix: string) => Promise<string>;
  mkdir: (path: string, options: { recursive: boolean }) => Promise<unknown>;
};

const defaultOperations: StageOperations = {
  tmpdir,
  realpath: async (path) => await realpath(path),
  mkdtemp: async (prefix) => await mkdtemp(prefix),
  mkdir: async (path, options) => await mkdir(path, options),
};

const defaultRemoveStage: RemoveStage = async (path, options) => {
  await rm(path, options);
};

async function canonicalTmpRoot(operations: StageOperations): Promise<string> {
  const configured = operations.tmpdir();
  try {
    // Canonicalise once: on macOS /var is a symlink to /private/var.
    return await operations.realpath(configured);
  } catch (error) {
    // The configured temporary directory is an absolute host path; never
    // interpolate it into a diagnostic. The code says what failed.
    throw renderFailed(
      `cannot use the configured temporary directory (${describeFsError(error)})`,
      {
        subject: 'temporary stage',
        action: 'set TMPDIR to a writable directory and re-run',
        cause: error,
      },
    );
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
    if (!isPathInside(tmpRoot, root)) {
      throw pathUnsafe('refusing to remove a path outside the temporary root', {
        subject: root,
      });
    }
    await removeStage(root, { recursive: true, force: true });
  } catch (error) {
    // The stage root is under the host temporary directory, so only its leaf
    // name is safe to print; the absolute prefix is redacted.
    process.stderr.write(
      `farna-bootstrapper: warning: could not remove temporary stage ${basename(root)} (${describeFsError(error)})\n`,
    );
  }
}

/**
 * Create a disposable stage and always attempt to remove it. The stage is the
 * only place a renderer is allowed to write before verification passes.
 *
 * Creation is inside the `try`: a failure after `mkdtemp` has created the
 * directory (a failed `realpath` or `mkdir`) still reaches the cleanup, so an
 * early failure cannot leak a temporary directory.
 */
export async function withStage<T>(
  run: (stage: Stage) => Promise<T>,
  removeStage: RemoveStage = defaultRemoveStage,
  operations: StageOperations = defaultOperations,
): Promise<T> {
  const tmpRoot = await canonicalTmpRoot(operations);
  let created: string | undefined;
  let root: string | undefined;
  let ready = false;
  try {
    created = await operations.mkdtemp(join(tmpRoot, 'farna-bootstrapper-'));
    root = await operations.realpath(created);
    const sourceRoot = join(root, 'src');
    const outputRoot = join(root, 'out');
    await operations.mkdir(sourceRoot, { recursive: true });
    await operations.mkdir(outputRoot, { recursive: true });
    ready = true;
    return await run({ root, sourceRoot, outputRoot });
  } catch (error) {
    if (ready) {
      // The failure happened in `run`; it owns its diagnostic.
      throw error;
    }
    throw renderFailed(`cannot create a temporary render stage (${describeFsError(error)})`, {
      subject: 'temporary stage',
      action: 'set TMPDIR to a writable directory and re-run',
      cause: error,
    });
  } finally {
    const removable = root ?? created;
    if (removable !== undefined) {
      await cleanupStage(removable, tmpRoot, removeStage);
    }
  }
}
