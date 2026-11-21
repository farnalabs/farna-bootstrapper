import { mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { MANAGED_FILE_MAX_BYTES } from '../core/constants.js';
import { pathUnsafe, writeFailed } from '../core/errors.js';
import { describeFsError, readBoundedBytes } from '../core/fs.js';
import { containedTarget, lstatOrUndefined } from '../core/paths.js';
import { stagingName, sweepStaging } from './staging.js';

/** A managed path is relative, POSIX-spelled, and cannot escape the root. */
export function assertSafeRelativePath(path: string): void {
  if (path === '' || path.includes('\\') || isAbsolute(path)) {
    throw pathUnsafe('managed path is not relative', { subject: path });
  }
  const normalised = posix.normalize(path);
  if (normalised !== path || normalised.startsWith('../') || normalised === '..') {
    throw pathUnsafe('managed path escapes the repository root', { subject: path });
  }
}

export type FileStatus = 'written' | 'unchanged';

export type CommitResult = {
  statuses: Array<{ path: string; status: FileStatus }>;
};

/**
 * The filesystem calls a commit makes. The seam exists so the rename-failure
 * and partial-mkdir paths can be tested deterministically; production always
 * uses the defaults.
 */
export type CommitOperations = {
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  removeDirectory: (path: string) => Promise<void>;
};

const defaultOperations: CommitOperations = {
  // One level at a time. A recursive mkdir can create ancestors and then throw,
  // leaving directories the rollback has no record of; the caller records each
  // successful level instead.
  mkdir: async (path) => {
    await mkdir(path);
  },
  writeFile: async (path, data) => {
    // The raw bytes are written as-is: a restore must not round-trip a
    // repository file through a lossy text encoding.
    await writeFile(path, data);
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  remove: async (path) => {
    await rm(path, { force: true });
  },
  removeDirectory: async (path) => {
    await rmdir(path);
  },
};

export type ManagedTarget = {
  path: string;
  target: string;
  /** The exact bytes on disk, or `undefined` when the path does not exist. */
  existing: Buffer | undefined;
};

/**
 * Resolve one managed path and read its current bytes, refusing a symlinked
 * ancestor, a symlink at the target, a directory in the way, or any other
 * non-regular file. Shared by the write path and by `--dry-run`, so the plan
 * cannot report a state the write path would refuse.
 *
 * The read returns bytes, never decoded text: a managed file holding an invalid
 * byte decodes to U+FFFD, which can equal a rule that legitimately contains
 * U+FFFD. Comparing the text would call such a file clean and never repair it.
 */
export async function inspectManagedTarget(repoRoot: string, path: string): Promise<ManagedTarget> {
  assertSafeRelativePath(path);
  const target = await containedTarget(repoRoot, path);
  const stats = await lstatOrUndefined(target, path);
  if (stats?.isSymbolicLink()) {
    throw pathUnsafe(`refusing to write through a symbolic link: ${path}`, {
      subject: path,
      action: 'replace the symbolic link with a real file',
    });
  }
  if (stats?.isDirectory()) {
    throw writeFailed(`cannot write ${path}: a directory is in the way`, {
      subject: path,
      action: 'remove the directory and re-run generate',
    });
  }
  if (stats !== undefined && !stats.isFile()) {
    throw writeFailed(`cannot write ${path}: the path is not a regular file`, {
      subject: path,
    });
  }
  return {
    path,
    target,
    existing:
      stats === undefined
        ? undefined
        : await readBoundedBytes(target, path, {
            action: 'make the managed file readable and re-run generate',
            maxBytes: MANAGED_FILE_MAX_BYTES,
          }),
  };
}

type PlannedFile = ManagedTarget & { bytes: string };
type StagedFile = PlannedFile & { temporary: string };
type CreatedDirectory = { path: string; subject: string };

async function removeTemporaryFiles(
  staged: readonly StagedFile[],
  operations: CommitOperations,
): Promise<void> {
  for (const item of staged) {
    try {
      await operations.remove(item.temporary);
    } catch {
      // A leftover temp file is harmless and never a managed path.
    }
  }
}

/**
 * Write the verified managed set atomically. Callers must have verified first;
 * this function never renders and never decides whether the output is correct.
 *
 * The whole set is preflighted (no symlinked ancestor, no directory in the way)
 * and the tool's own staging namespace is swept before anything is staged, so a
 * killed earlier run cannot leave a permanent red `check`. A failure while
 * staging removes the temporaries and the directories this call created; the
 * diagnostic names any directory it could not remove rather than claiming a
 * clean tree. A rename failure restores the files this call already replaced and
 * reports any file it could not restore by name.
 */
export async function commitFiles(
  repoRoot: string,
  files: Array<{ path: string; bytes: string }>,
  overrides: Partial<CommitOperations> = {},
): Promise<CommitResult> {
  const operations: CommitOperations = { ...defaultOperations, ...overrides };
  const planned: PlannedFile[] = [];
  for (const file of files) {
    planned.push({ ...(await inspectManagedTarget(repoRoot, file.path)), bytes: file.bytes });
  }

  // Sweep our own namespace in every managed directory. Only directories the
  // plan already validated are touched, and only names matching this tool's
  // staging shape.
  const stagingDirectories = new Map<string, string>();
  for (const item of planned) {
    stagingDirectories.set(dirname(item.target), posix.dirname(item.path));
  }
  for (const directory of stagingDirectories.keys()) {
    await sweepStaging(directory);
  }

  const statuses: CommitResult['statuses'] = planned.map((item) => ({
    path: item.path,
    status:
      item.existing?.equals(Buffer.from(item.bytes, 'utf8')) === true ? 'unchanged' : 'written',
  }));
  const writes = planned.filter(
    (item) => item.existing === undefined || !item.existing.equals(Buffer.from(item.bytes, 'utf8')),
  );

  const staged: StagedFile[] = [];
  const createdDirectories: CreatedDirectory[] = [];

  const ensureDirectory = async (directory: string, subject: string): Promise<void> => {
    const missing: string[] = [];
    let current = directory;
    for (;;) {
      if ((await lstatOrUndefined(current, subject)) !== undefined) {
        break;
      }
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    // Parent first, recording each level the moment it is created: a failure on
    // a deeper level leaves the earlier levels known to the rollback. A
    // concurrent process may create one of these levels first; `EEXIST` for a
    // directory that is now present is success, never a failure to roll back.
    for (const level of [...missing].reverse()) {
      try {
        await operations.mkdir(level);
      } catch (error) {
        const stats =
          describeFsError(error) === 'EEXIST' ? await lstatOrUndefined(level, subject) : undefined;
        if (stats?.isDirectory() !== true) {
          throw error;
        }
        continue;
      }
      createdDirectories.push({ path: level, subject });
    }
  };

  const removeCreatedDirectories = async (): Promise<string[]> => {
    const failed: string[] = [];
    for (const directory of [...createdDirectories].sort((a, b) => b.path.length - a.path.length)) {
      try {
        await operations.removeDirectory(directory.path);
      } catch {
        // A non-empty directory means something other than generate wrote to
        // it; name it rather than claiming the tree is clean.
        failed.push(directory.subject);
      }
    }
    return failed;
  };

  let stagingPath = writes[0]?.path ?? '';
  try {
    for (const item of writes) {
      stagingPath = item.path;
      await ensureDirectory(dirname(item.target), posix.dirname(item.path));
      const temporary = join(dirname(item.target), stagingName(item.target));
      // Record before writing, so a write that creates then fails is still
      // removed by the catch below.
      staged.push({ ...item, temporary });
      await operations.writeFile(temporary, item.bytes);
    }
  } catch (error) {
    await removeTemporaryFiles(staged, operations);
    const leftBehind = await removeCreatedDirectories();
    const outcome =
      leftBehind.length === 0
        ? 'nothing was written'
        : `no managed file was written, but these directories could not be removed: ${leftBehind.join(', ')}`;
    throw writeFailed(`cannot stage ${stagingPath}; ${outcome}`, {
      subject: stagingPath,
      action:
        leftBehind.length === 0
          ? 'fix the filesystem and re-run generate'
          : 'remove the named directories and re-run generate',
      cause: error,
    });
  }

  const replaced: StagedFile[] = [];
  const restoreFailures: string[] = [];
  const changedByAnotherWriter: string[] = [];
  let renamePath = staged[0]?.path ?? '';
  try {
    for (const item of staged) {
      renamePath = item.path;
      await operations.rename(item.temporary, item.target);
      replaced.push(item);
    }
  } catch (error) {
    await removeTemporaryFiles(
      staged.filter((item) => !replaced.includes(item)),
      operations,
    );
    for (const item of [...replaced].reverse()) {
      try {
        // Re-check the target before restoring it. Another process may have
        // written its own (newer) bytes since this call renamed: overwriting
        // them would undo a concurrent winner. Only restore a file that still
        // holds exactly the bytes this call put there; a missing target needs
        // no restore.
        const stats = await lstatOrUndefined(item.target, item.path);
        if (stats === undefined) {
          continue;
        }
        const current = await readBoundedBytes(item.target, item.path, {
          action: 'make the managed file readable and re-run generate',
          maxBytes: MANAGED_FILE_MAX_BYTES,
        });
        if (!current.equals(Buffer.from(item.bytes, 'utf8'))) {
          changedByAnotherWriter.push(item.path);
          continue;
        }
        if (item.existing === undefined) {
          await operations.remove(item.target);
        } else {
          await operations.writeFile(item.target, item.existing);
        }
      } catch (restoreError) {
        restoreFailures.push(`${item.path} (${describeFsError(restoreError)})`);
      }
    }
    const leftBehind = await removeCreatedDirectories();

    const outcome =
      restoreFailures.length > 0
        ? `${restoreFailures.length} earlier file(s) could NOT be restored: ${restoreFailures.join(', ')}`
        : changedByAnotherWriter.length > 0
          ? `earlier files were left as another writer left them: ${changedByAnotherWriter.join(', ')}`
          : replaced.length > 0
            ? 'earlier files were restored'
            : 'no earlier file was replaced';
    const directories =
      leftBehind.length === 0
        ? ''
        : `; these directories could not be removed: ${leftBehind.join(', ')}`;
    throw writeFailed(`cannot write ${renamePath}; ${outcome}${directories}`, {
      subject: renamePath,
      action:
        restoreFailures.length > 0
          ? `inspect and re-run generate; restore failed for ${restoreFailures.join(', ')}`
          : 're-run generate after fixing the filesystem',
      cause: error,
    });
  }

  return { statuses };
}
