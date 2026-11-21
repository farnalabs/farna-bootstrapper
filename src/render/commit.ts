import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';
import { pathUnsafe, writeFailed } from '../core/errors.js';
import { containedTarget, lstatOrUndefined } from '../core/paths.js';

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
 * path can be tested deterministically; production always uses the defaults.
 */
export type CommitOperations = {
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  removeDirectory: (path: string) => Promise<void>;
};

const defaultOperations: CommitOperations = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeFile: async (path, data) => {
    await writeFile(path, data, 'utf8');
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
  existing: string | undefined;
};

/**
 * Resolve one managed path and read its current bytes, refusing a symlinked
 * ancestor, a symlink at the target, a directory in the way, or any other
 * non-regular file. Shared by the write path and by `--dry-run`, so the plan
 * cannot report a state the write path would refuse.
 */
export async function inspectManagedTarget(repoRoot: string, path: string): Promise<ManagedTarget> {
  assertSafeRelativePath(path);
  const target = await containedTarget(repoRoot, path);
  const stats = await lstatOrUndefined(target);
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
    existing: stats === undefined ? undefined : await readFile(target, 'utf8'),
  };
}

type PlannedFile = ManagedTarget & { bytes: string };
type StagedFile = PlannedFile & { temporary: string };

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
 * and staged into sibling temporary files before the first rename. A failure
 * while staging removes the temporaries and leaves the tree untouched. A rename
 * failure restores the files this call already replaced and reports any file it
 * could not restore by name: the diagnostic never claims a restore it did not
 * achieve.
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

  const statuses: CommitResult['statuses'] = planned.map((item) => ({
    path: item.path,
    status: item.existing === item.bytes ? 'unchanged' : 'written',
  }));
  const writes = planned.filter((item) => item.existing !== item.bytes);

  const staged: StagedFile[] = [];
  const createdDirectories: string[] = [];

  const ensureDirectory = async (directory: string): Promise<void> => {
    const missing: string[] = [];
    let current = directory;
    for (;;) {
      if ((await lstatOrUndefined(current)) !== undefined) {
        break;
      }
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    if (missing.length === 0) {
      return;
    }
    await operations.mkdir(directory);
    createdDirectories.push(...missing);
  };

  const removeCreatedDirectories = async (): Promise<void> => {
    for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
      try {
        await operations.removeDirectory(directory);
      } catch {
        // A non-empty directory means something else wrote to it.
      }
    }
  };

  let stagingPath = writes[0]?.path ?? '';
  try {
    for (const item of writes) {
      stagingPath = item.path;
      await ensureDirectory(dirname(item.target));
      const temporary = join(
        dirname(item.target),
        `.${basename(item.target)}.farna-tmp-${process.pid}-${randomUUID()}`,
      );
      await operations.writeFile(temporary, item.bytes);
      staged.push({ ...item, temporary });
    }
  } catch (error) {
    await removeTemporaryFiles(staged, operations);
    await removeCreatedDirectories();
    throw writeFailed(`cannot stage ${stagingPath}; nothing was written`, {
      subject: stagingPath,
      cause: error,
    });
  }

  const replaced: StagedFile[] = [];
  const restoreFailures: string[] = [];
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
        if (item.existing === undefined) {
          await operations.remove(item.target);
        } else {
          await operations.writeFile(item.target, item.existing);
        }
      } catch (restoreError) {
        const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
        restoreFailures.push(`${item.path} (${detail})`);
      }
    }
    await removeCreatedDirectories();

    const outcome =
      restoreFailures.length > 0
        ? `${restoreFailures.length} earlier file(s) could NOT be restored: ${restoreFailures.join(', ')}`
        : replaced.length > 0
          ? 'earlier files were restored'
          : 'no earlier file was replaced';
    throw writeFailed(`cannot write ${renamePath}; ${outcome}`, {
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
