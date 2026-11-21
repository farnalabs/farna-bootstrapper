import { rm } from 'node:fs/promises';
import {
  LOCK_PATH,
  MANAGED_FILE_MAX_BYTES,
  MANAGED_OUTPUT_DIRS,
  MANAGED_OUTPUT_FILES,
  SUPPORTED_TARGETS,
} from '../core/constants.js';
import { driftRefused, pathUnsafe, writeFailed } from '../core/errors.js';
import { describeFsError, readBoundedBytes } from '../core/fs.js';
import { compareCodepoints, sha256Hex } from '../core/json.js';
import { containedTarget, lstatOrUndefined } from '../core/paths.js';
import type { LockFileEntry } from '../lock/lockfile.js';
import { assertSafeRelativePath } from './commit.js';

/**
 * A path recorded in the committed lockfile is this tool's output. When the
 * current source no longer produces it — a persona switch, a removed resource,
 * a target edit — it is an orphan: `check` reports it as drift, and `generate`
 * may remove it.
 *
 * Removal is deliberately narrow, because a lockfile is a file a user could
 * hand-edit and a managed directory is one a user may also keep files in:
 *
 * - the path must be relative and escape-free;
 * - it must lie in a location one of the supported targets can own (a managed
 *   directory subtree, or a whole root config file); this deliberately spans
 *   targets, so switching the configured target does not strand the previous
 *   target's recorded artefacts as unremovable;
 * - it must still be a regular file (a symlink is refused, never followed);
 * - its bytes must still equal the SHA-256 the lockfile recorded. A changed file
 *   is drift, not this tool's output any more, so it is refused rather than
 *   destroyed.
 *
 * A file that fails any of those checks is reported and the run writes nothing.
 * An already-absent orphan is simply dropped from the new lockfile.
 */

/** True when one of the supported renderers can own this repository-relative path. */
export function isManagedOutputPath(path: string): boolean {
  for (const target of SUPPORTED_TARGETS) {
    if ((MANAGED_OUTPUT_FILES[target] as readonly string[]).includes(path)) {
      return true;
    }
    const managed = MANAGED_OUTPUT_DIRS[target].some(
      (directory) => path.startsWith(`${directory}/`) && path.length > directory.length + 1,
    );
    if (managed) {
      return true;
    }
  }
  return false;
}

/**
 * Validate every recorded path the current plan no longer produces, and return
 * the ones `generate` may remove. Nothing is removed here: a dry run and a real
 * run share this preflight, so the plan can never report a removal the write
 * path would refuse.
 */
export async function planOrphans(
  repoRoot: string,
  recorded: readonly LockFileEntry[],
  expected: ReadonlySet<string>,
): Promise<string[]> {
  const orphans: string[] = [];
  for (const entry of recorded) {
    if (entry.path === LOCK_PATH || expected.has(entry.path)) {
      continue;
    }
    assertSafeRelativePath(entry.path);
    if (!isManagedOutputPath(entry.path)) {
      throw pathUnsafe(
        `refusing to remove ${entry.path}: it is recorded but is not a managed output location`,
        {
          subject: entry.path,
          action: 'remove it deliberately, then re-run generate',
        },
      );
    }
    const absolute = await containedTarget(repoRoot, entry.path);
    const stats = await lstatOrUndefined(absolute, entry.path);
    if (stats === undefined) {
      // Already gone. The new lockfile drops the record, so the next `check`
      // is clean without any deletion.
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw pathUnsafe(`refusing to remove a symbolic link at a recorded path: ${entry.path}`, {
        subject: entry.path,
        action: 'remove the symbolic link deliberately, then re-run generate',
      });
    }
    if (!stats.isFile()) {
      throw writeFailed(`cannot remove ${entry.path}: it is not a regular file`, {
        subject: entry.path,
        action: 'remove the directory or special file deliberately, then re-run generate',
      });
    }
    const bytes = await readBoundedBytes(absolute, entry.path, {
      action: 'make the recorded file readable and re-run generate',
      maxBytes: MANAGED_FILE_MAX_BYTES,
    });
    if (sha256Hex(bytes) !== entry.sha256) {
      throw driftRefused(
        `refusing to remove ${entry.path}: it no longer matches the bytes recorded as owned`,
        {
          subject: entry.path,
          action:
            'move the file aside deliberately, or restore the recorded bytes, then re-run generate',
        },
      );
    }
    orphans.push(entry.path);
  }
  return orphans.sort(compareCodepoints);
}

/** Remove the preflighted orphans. A failure names the path and never pretends otherwise. */
export async function removeOrphans(repoRoot: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const absolute = await containedTarget(repoRoot, path);
    try {
      await rm(absolute, { force: true });
    } catch (error) {
      throw writeFailed(
        `cannot remove ${path} (${describeFsError(error)}); the tree is partially updated`,
        {
          subject: path,
          action: 'remove the file deliberately, then re-run generate',
          cause: error,
        },
      );
    }
  }
}
