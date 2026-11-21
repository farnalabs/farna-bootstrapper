import { randomUUID } from 'node:crypto';
import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { STAGING_INFIX } from '../core/constants.js';

/**
 * The tool's own staging namespace. `commitFiles` writes
 * `.<target>.farna-tmp-<pid>-<uuid>` siblings on the same filesystem and
 * renames them into place. The namespace is:
 *
 * - swept at the start of `generate`, so a killed run's leftovers never
 *   accumulate; and
 * - ignored by `check`, so a killed run can never make the tree permanently red.
 *
 * The predicate is deliberately narrow: a hidden sibling carrying the infix and
 * this tool's own `<pid>-<uuid>` suffix. A user file named `notes.farna-tmp.md`
 * is not ours.
 */
const STAGING_NAME_RE = new RegExp(`^\\..+\\${STAGING_INFIX}\\d+-[0-9a-f-]{36}$`);

export function stagingName(target: string): string {
  return `.${basename(target)}${STAGING_INFIX}${process.pid}-${randomUUID()}`;
}

export function isStagingName(name: string): boolean {
  return STAGING_NAME_RE.test(name);
}

/**
 * Remove this tool's staging siblings from one directory. Best effort: a
 * leftover that cannot be removed is harmless (it is not a managed path), and
 * `check` ignores the namespace rather than reporting it forever.
 */
export async function sweepStaging(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isStagingName(name)) {
      continue;
    }
    const path = join(directory, name);
    try {
      const stats = await lstat(path);
      // Never recurse: our staging entries are files (or a symlink an attacker
      // planted under our name). A directory is not ours to delete.
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        continue;
      }
      await rm(path, { force: true });
    } catch {
      // Best effort; the next generate sweeps again.
    }
  }
}
