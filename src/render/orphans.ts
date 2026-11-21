import { rm } from 'node:fs/promises';
import {
  LOCK_PATH,
  MANAGED_FILE_MAX_BYTES,
  MANAGED_OUTPUT_DIRS,
  MANAGED_OUTPUT_FILES,
  SUPPORTED_TARGETS,
} from '../core/constants.js';
import { driftRefused, pathUnsafe, writeFailed } from '../core/errors.js';
import { decodeUtf8, describeFsError, readBoundedBytes } from '../core/fs.js';
import { compareCodepoints, sha256Hex } from '../core/json.js';
import { containedTarget, lstatOrUndefined } from '../core/paths.js';
import type { LockFileEntry } from '../lock/lockfile.js';
import { assertSafeRelativePath } from './commit.js';
import { ownedSubset, parseStructuredDocument, structuredOwnedDigest } from './structured.js';

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
 * A `structured` entry owns only its declared keys. It is removed only when the
 * file carries nothing else; a file that also carries the user's own keys is
 * refused, and the record is dropped once the owned keys are gone.
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
  | { kind: 'removable' };

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
  let document: Record<string, unknown>;
  try {
    document = parseStructuredDocument(decodeUtf8(bytes, path), path);
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
    throw driftRefused(
      `refusing to remove ${path}: it also carries keys this tool does not own (${foreignKeys.join(', ')})`,
      {
        subject: path,
        action: `remove the ${ownedKeys.join(', ')} key from ${path} yourself, then re-run generate; the other keys are yours`,
      },
    );
  }
  return { kind: 'removable' };
}

/**
 * Validate every recorded path the current plan no longer produces, and return
 * the entries `generate` may remove. Nothing is removed here: a dry run and a
 * real run share this preflight, so the plan can never report a removal the
 * write path would refuse.
 */
export async function planOrphans(
  repoRoot: string,
  recorded: readonly LockFileEntry[],
  expected: ReadonlySet<string>,
): Promise<LockFileEntry[]> {
  const orphans: LockFileEntry[] = [];
  for (const entry of recorded) {
    if (entry.path === LOCK_PATH || expected.has(entry.path)) {
      continue;
    }
    const inspection = await inspectOrphan(repoRoot, entry);
    if (inspection.kind === 'removable') {
      orphans.push(entry);
    }
  }
  return orphans.sort((a, b) => compareCodepoints(a.path, b.path));
}

export type RemovedOrphan = { path: string; status: 'removed' | 'missing' };

/**
 * Remove the preflighted orphans, re-checking each one immediately before the
 * `rm`. A path that vanished since the preflight is reported as `missing`; a
 * failure names the path and never pretends otherwise.
 */
export async function removeOrphans(
  repoRoot: string,
  entries: readonly LockFileEntry[],
): Promise<RemovedOrphan[]> {
  const removed: RemovedOrphan[] = [];
  for (const entry of entries) {
    const inspection = await inspectOrphan(repoRoot, entry);
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
  }
  return removed;
}
