import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { pathUnsafe } from '../core/errors.js';

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

async function currentBytes(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Write the verified managed set. Callers must have verified first; this
 * function never renders and never decides whether the output is correct.
 * Writes are atomic (temp file then rename in the same directory).
 */
export async function commitFiles(
  repoRoot: string,
  files: Array<{ path: string; bytes: string }>,
): Promise<CommitResult> {
  const statuses: CommitResult['statuses'] = [];
  for (const file of files) {
    assertSafeRelativePath(file.path);
    const target = join(repoRoot, file.path);
    const existing = await currentBytes(target);
    if (existing === file.bytes) {
      statuses.push({ path: file.path, status: 'unchanged' });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.farna-tmp`;
    await writeFile(temporary, file.bytes, 'utf8');
    await rename(temporary, target);
    statuses.push({ path: file.path, status: 'written' });
  }
  return { statuses };
}
