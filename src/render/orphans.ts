import { rm } from 'node:fs/promises';
import {
  LOCK_PATH,
  MANAGED_FILE_MAX_BYTES,
  MANAGED_OUTPUT_DIRS,
  MANAGED_OUTPUT_FILES,
  SUPPORTED_TARGETS,
} from '../core/constants.js';
import { driftRefused, FarnaError, pathUnsafe, writeFailed } from '../core/errors.js';
import { decodeUtf8, describeFsError, readBoundedBytes } from '../core/fs.js';
import { compareCodepoints, sha256Hex } from '../core/json.js';
import { containedTarget, lstatOrUndefined } from '../core/paths.js';
import type { LockFileEntry } from '../lock/lockfile.js';
import { assertSafeRelativePath, commitFiles } from './commit.js';
import {
  mergeStructuredText,
  ownedSubset,
  parseStructuredDocument,
  structuredOwnedDigest,
} from './structured.js';

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
 * An absent path is dropped from the new lockfile before any of the guards
 * apply: there is nothing to remove, and a recorded path outside a managed
 * location that no longer exists could never satisfy an action that says
 * "remove it deliberately".
 *
 * A `structured` entry owns only its declared keys. When the current source no
 * longer produces it, only those keys are deleted in place: a file that also
 * carries the user's own keys is kept (with their comments) and the record is
 * dropped, while a file left with nothing but the owned keys is removed. The
 * record is also dropped, without touching the file, once the user has already
 * removed the owned keys.
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

type InspectedOrphan =
  | { kind: 'absent' }
  /** The owned keys of a structured path are already gone; nothing is left to remove. */
  | { kind: 'already-removed' }
  | { kind: 'removable' }
  /** The file keeps the user's own keys; only the owned key(s) are deleted. */
  | { kind: 'rewrite'; bytes: string };

/**
 * Inspect one recorded orphan. Shared by the preflight and the removal itself,
 * so the bytes that are deleted are re-checked against the recorded digest
 * immediately before `rm` rather than trusted from an earlier pass (a file can
 * change between the two).
 */
async function inspectOrphan(repoRoot: string, entry: LockFileEntry): Promise<InspectedOrphan> {
  const path = entry.path;
  assertSafeRelativePath(path);
  const absolute = await containedTarget(repoRoot, path);
  const stats = await lstatOrUndefined(absolute, path);
  if (stats === undefined) {
    return { kind: 'absent' };
  }
  // The managed-location guard applies only to a path that exists: a missing
  // path is dropped from the lockfile, never refused with an action the user
  // cannot carry out.
  if (!isManagedOutputPath(path)) {
    throw pathUnsafe(
      `refusing to remove ${path}: it is recorded but is not a managed output location`,
      {
        subject: path,
        action: 'remove it deliberately, then re-run generate',
      },
    );
  }
  if (stats.isSymbolicLink()) {
    throw pathUnsafe(`refusing to remove a symbolic link at a recorded path: ${path}`, {
      subject: path,
      action: 'remove the symbolic link deliberately, then re-run generate',
    });
  }
  if (!stats.isFile()) {
    throw writeFailed(`cannot remove ${path}: it is not a regular file`, {
      subject: path,
      action: 'remove the directory or special file deliberately, then re-run generate',
    });
  }

  const ownedKeys = entry.shape === 'structured' ? entry.ownedKeys : undefined;
  if (ownedKeys === undefined) {
    const bytes = await readBoundedBytes(absolute, path, {
      action: 'make the recorded file readable and re-run generate',
      maxBytes: MANAGED_FILE_MAX_BYTES,
    });
    if (sha256Hex(bytes) !== entry.sha256) {
      throw driftRefused(
        `refusing to remove ${path}: it no longer matches the bytes recorded as owned`,
        {
          subject: path,
          action:
            'move the file aside deliberately, or restore the recorded bytes, then re-run generate',
        },
      );
    }
    return { kind: 'removable' };
  }

  const bytes = await readBoundedBytes(absolute, path, {
    action: 'make the recorded file readable and re-run generate',
    maxBytes: MANAGED_FILE_MAX_BYTES,
  });
  const text = decodeUtf8(bytes, path);
  let document: Record<string, unknown>;
  try {
    document = parseStructuredDocument(text, path);
  } catch (error) {
    throw driftRefused(
      `refusing to remove ${path}: it is no longer a JSON object this tool wrote`,
      {
        subject: path,
        action:
          'restore the recorded document, or move it aside deliberately, then re-run generate',
        cause: error,
      },
    );
  }
  const owned = ownedSubset(document, ownedKeys);
  if (Object.keys(owned).length === 0) {
    // The user already removed the keys this tool owned. The file is theirs
    // now, so it is left alone and the record is dropped.
    return { kind: 'already-removed' };
  }
  const digest = structuredOwnedDigest(document, ownedKeys);
  if (digest.sha256 !== entry.sha256) {
    throw driftRefused(
      `refusing to remove ${path}: ${ownedKeys.join(', ')} no longer matches the bytes recorded as owned`,
      {
        subject: path,
        action:
          'restore the recorded value, or move the file aside deliberately, then re-run generate',
      },
    );
  }
  const foreignKeys = Object.keys(document)
    .filter((key) => !ownedKeys.includes(key))
    .sort(compareCodepoints);
  if (foreignKeys.length > 0) {
    // The file is still partly the user's. Delete only the key this tool owns
    // and leave their keys and comments exactly where they were; the new
    // lockfile drops this record because the path is no longer produced.
    return {
      kind: 'rewrite',
      bytes: mergeStructuredText(text, '{}\n', ownedKeys, path),
    };
  }
  return { kind: 'removable' };
}

/** What `generate` will do for a recorded path the current plan no longer produces. */
export type OrphanPlan = {
  entry: LockFileEntry;
  action: 'remove' | 'rewrite';
};

/**
 * Validate every recorded path the current plan no longer produces, and return
 * the action `generate` will take. Nothing is written here: a dry run and a
 * real run share this preflight, so the plan can never report an edit the write
 * path would refuse.
 */
export async function planOrphans(
  repoRoot: string,
  recorded: readonly LockFileEntry[],
  expected: ReadonlySet<string>,
): Promise<OrphanPlan[]> {
  const orphans: OrphanPlan[] = [];
  for (const entry of recorded) {
    if (entry.path === LOCK_PATH || expected.has(entry.path)) {
      continue;
    }
    const inspection = await inspectOrphan(repoRoot, entry);
    if (inspection.kind === 'removable') {
      orphans.push({ entry, action: 'remove' });
    } else if (inspection.kind === 'rewrite') {
      orphans.push({ entry, action: 'rewrite' });
    }
  }
  return orphans.sort((a, b) => compareCodepoints(a.entry.path, b.entry.path));
}

export type RemovedOrphan = { path: string; status: 'removed' | 'updated' | 'missing' };

/** A bare entry is accepted for callers that already preflighted (and for tests). */
export type OrphanTarget = LockFileEntry | OrphanPlan;

function lockEntry(target: OrphanTarget): LockFileEntry {
  return 'entry' in target ? target.entry : target;
}

/**
 * Re-throw a removal failure with the paths this run already removed named. The
 * failure is true of one path and false of the run: earlier removals happened,
 * so the tree is partially updated and the reader must be told which paths are
 * gone. This is the same honesty the commit failure carries.
 */
function removalFailure(error: unknown, removed: readonly RemovedOrphan[]): unknown {
  const paths = removed.filter((entry) => entry.status === 'removed').map((entry) => entry.path);
  const updated = removed.filter((entry) => entry.status === 'updated').map((entry) => entry.path);
  if (!(error instanceof FarnaError) || (paths.length === 0 && updated.length === 0)) {
    return error;
  }
  const details: string[] = [];
  if (paths.length > 0) {
    details.push(`this run already removed ${paths.length} recorded path(s) (${paths.join(', ')})`);
  }
  if (updated.length > 0) {
    details.push(
      `this run already updated ${updated.length} recorded path(s) (${updated.join(', ')})`,
    );
  }
  return new FarnaError(
    error.code,
    `${error.message}; ${details.join('; ')} before the write failed, so the tree is partially updated`,
    {
      ...(error.subject === undefined ? {} : { subject: error.subject }),
      action:
        're-run generate after fixing the filesystem; the lockfile still records the affected paths',
      cause: error,
    },
  );
}

/**
 * Remove the preflighted orphans, re-checking each one immediately before the
 * `rm`. A path that vanished since the preflight is reported as `missing`; a
 * failure names the path, and every path already removed this run, rather than
 * pretending the tree is unchanged.
 */
export async function removeOrphans(
  repoRoot: string,
  orphans: readonly OrphanTarget[],
): Promise<RemovedOrphan[]> {
  const removed: RemovedOrphan[] = [];
  for (const target of orphans) {
    const entry = lockEntry(target);
    try {
      const inspection = await inspectOrphan(repoRoot, entry);
      if (inspection.kind === 'rewrite') {
        await commitFiles(repoRoot, [{ path: entry.path, bytes: inspection.bytes }]);
        removed.push({ path: entry.path, status: 'updated' });
        continue;
      }
      if (inspection.kind !== 'removable') {
        removed.push({ path: entry.path, status: 'missing' });
        continue;
      }
      const absolute = await containedTarget(repoRoot, entry.path);
      try {
        await rm(absolute, { force: true });
      } catch (error) {
        throw writeFailed(
          `cannot remove ${entry.path} (${describeFsError(error)}); the tree is partially updated`,
          {
            subject: entry.path,
            action: 'remove the file deliberately, then re-run generate',
            cause: error,
          },
        );
      }
      removed.push({ path: entry.path, status: 'removed' });
    } catch (error) {
      throw removalFailure(error, removed);
    }
  }
  return removed;
}
