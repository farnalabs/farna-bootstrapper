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
 * The current bytes of a path, or `undefined` when it is absent or is not a
 * regular file. Never follows a symbolic link: a link is "no current bytes",
 * so a plan or a commit treats it as a change to be refused by the preflight.
 */
export async function currentBytes(path: string): Promise<string | undefined> {
  const stats = await lstatOrUndefined(path);
  if (stats === undefined || !stats.isFile() || stats.isSymbolicLink()) {
    return undefined;
  }
  return readFile(path, 'utf8');
}

type PlannedFile = {
  path: string;
  bytes: string;
  target: string;
  existing: string | undefined;
};

type StagedFile = PlannedFile & { temporary: string };

async function removeTemporaryFiles(staged: readonly StagedFile[]): Promise<void> {
  for (const item of staged) {
    try {
      await rm(item.temporary, { force: true });
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
 * while staging removes the temporaries and leaves the tree untouched; a rename
 * failure restores the files this call already replaced.
 */
export async function commitFiles(
  repoRoot: string,
  files: Array<{ path: string; bytes: string }>,
): Promise<CommitResult> {
  const planned: PlannedFile[] = [];
  for (const file of files) {
    assertSafeRelativePath(file.path);
    const target = await containedTarget(repoRoot, file.path);
    const stats = await lstatOrUndefined(target);
    if (stats?.isSymbolicLink()) {
      throw pathUnsafe(`refusing to write through a symbolic link: ${file.path}`, {
        subject: file.path,
        action: 'replace the symbolic link with a real file',
      });
    }
    if (stats?.isDirectory()) {
      throw writeFailed(`cannot write ${file.path}: a directory is in the way`, {
        subject: file.path,
        action: 'remove the directory and re-run generate',
      });
    }
    if (stats !== undefined && !stats.isFile()) {
      throw writeFailed(`cannot write ${file.path}: the path is not a regular file`, {
        subject: file.path,
      });
    }
    planned.push({
      path: file.path,
      bytes: file.bytes,
      target,
      existing: stats === undefined ? undefined : await readFile(target, 'utf8'),
    });
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
    await mkdir(directory, { recursive: true });
    createdDirectories.push(...missing);
  };

  const removeCreatedDirectories = async (): Promise<void> => {
    for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
      try {
        await rmdir(directory);
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
      await writeFile(temporary, item.bytes, 'utf8');
      staged.push({ ...item, temporary });
    }
  } catch (error) {
    await removeTemporaryFiles(staged);
    await removeCreatedDirectories();
    throw writeFailed(`cannot stage ${stagingPath}; nothing was written`, {
      subject: stagingPath,
      cause: error,
    });
  }

  const replaced: StagedFile[] = [];
  let renamePath = staged[0]?.path ?? '';
  try {
    for (const item of staged) {
      renamePath = item.path;
      await rename(item.temporary, item.target);
      replaced.push(item);
    }
  } catch (error) {
    await removeTemporaryFiles(staged.filter((item) => !replaced.includes(item)));
    for (const item of [...replaced].reverse()) {
      try {
        if (item.existing === undefined) {
          await rm(item.target, { force: true });
        } else {
          await writeFile(item.target, item.existing, 'utf8');
        }
      } catch {
        // Restoring a file is best-effort; the typed error below still names
        // the path that failed and the tree is left as close to its pre-run
        // state as the filesystem allows.
      }
    }
    await removeCreatedDirectories();
    throw writeFailed(`cannot write ${renamePath}; earlier files were restored`, {
      subject: renamePath,
      cause: error,
    });
  }

  return { statuses };
}
