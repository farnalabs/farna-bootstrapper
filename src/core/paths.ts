import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { invalidConfig, pathUnsafe } from './errors.js';
import { inspectionFailed } from './fs.js';

/**
 * Every filesystem path this tool reads for source or writes as output is
 * checked here. A symbolic link is never followed: it is refused, wherever it
 * points, because the product's contract is that the repository it describes
 * is the repository it reads and writes.
 */

/**
 * `lstat` a path. A missing path is `undefined`; any other failure (a path that
 * cannot be inspected because a parent denies search permission, say) is a
 * typed error naming the repository-relative subject when one is supplied.
 */
async function lstatOrUndefined(path: string, subject?: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    if (subject === undefined) {
      throw error;
    }
    inspectionFailed(subject, error);
  }
}

/**
 * `lstat` a path and refuse a symbolic link. Returns the stats, or `undefined`
 * when the path does not exist. A missing path is left to the caller, because
 * "optional" means different things to a source directory and an output file.
 */
export async function assertNoSymlink(path: string, subject: string): Promise<Stats | undefined> {
  const stats = await lstatOrUndefined(path, subject);
  if (stats?.isSymbolicLink() === true) {
    throw pathUnsafe(`symlink not allowed: ${subject}`, {
      subject,
      action: 'replace the symbolic link with a real file or directory',
    });
  }
  return stats;
}

/** A directory that must not be a symbolic link and must be a directory. */
export async function assertRealDirectory(
  path: string,
  subject: string,
): Promise<Stats | undefined> {
  const stats = await assertNoSymlink(path, subject);
  if (stats !== undefined && !stats.isDirectory()) {
    throw invalidConfig(`${subject} is not a directory`, {
      subject,
      action: 'replace it with a directory, or remove it',
    });
  }
  return stats;
}

/** A file that must not be a symbolic link and must be a regular file. */
export async function assertRealFile(path: string, subject: string): Promise<Stats | undefined> {
  const stats = await assertNoSymlink(path, subject);
  if (stats !== undefined && !stats.isFile()) {
    throw invalidConfig(`${subject} is not a regular file`, {
      subject,
      action: 'replace it with a regular file, or remove it',
    });
  }
  return stats;
}

function assertInside(root: string, candidate: string, subject: string): void {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(prefix)) {
    throw pathUnsafe('path resolves outside the repository root', { subject });
  }
}

/**
 * Resolve one repository-relative managed path to an absolute target, having
 * refused any symbolic link in any existing ancestor. The target itself is not
 * inspected here: a caller that writes refuses a symlinked target, and `check`
 * reports it as drift rather than following it. The canonical repository root
 * is resolved first, so a symlinked `repoRoot` (macOS `/tmp`, for example) is
 * compared canonically rather than by string prefix.
 */
export async function containedTarget(repoRoot: string, relativePath: string): Promise<string> {
  const root = await realpath(repoRoot);
  const segments = relativePath.split('/');
  const directorySegments = segments.slice(0, -1);
  let current = root;
  let walked = '';
  for (const segment of directorySegments) {
    current = join(current, segment);
    walked = walked === '' ? segment : `${walked}/${segment}`;
    const stats = await assertNoSymlink(current, walked);
    if (stats === undefined) {
      break;
    }
    if (!stats.isDirectory()) {
      throw pathUnsafe(`${walked} is not a directory`, { subject: walked });
    }
    assertInside(root, await realpath(current), walked);
  }
  return join(root, ...segments);
}

export { lstatOrUndefined };
