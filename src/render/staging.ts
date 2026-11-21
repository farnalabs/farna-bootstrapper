import { randomUUID } from 'node:crypto';
import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { STAGING_INFIX, STAGING_MAX_AGE_MS } from '../core/constants.js';

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
const STAGING_NAME_RE = new RegExp(`^\\..+\\${STAGING_INFIX}(\\d+)-[0-9a-f-]{36}$`);

export function stagingName(target: string): string {
  return `.${basename(target)}${STAGING_INFIX}${process.pid}-${randomUUID()}`;
}

export function isStagingName(name: string): boolean {
  return STAGING_NAME_RE.test(name);
}

/** The pid encoded in a staging name, or `undefined` for a non-staging name. */
export function stagingPid(name: string): number | undefined {
  const match = STAGING_NAME_RE.exec(name);
  if (match === null) {
    return undefined;
  }
  const pid = Number.parseInt(match[1] ?? '', 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Whether a process exists. `EPERM` means it exists and is not ours; only
 * `ESRCH` proves it is gone. Signal 0 performs no action, so this never
 * disturbs another process.
 */
function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

/**
 * Remove this tool's staging siblings from one directory. Best effort: a
 * leftover that cannot be removed is harmless (it is not a managed path), and
 * `check` ignores the namespace rather than reporting it forever.
 *
 * A sibling is swept only when its owning pid is gone, or when it is older than
 * a generous threshold. Sweeping every matching name would let one concurrent
 * `generate` delete another live run's staged file between its write and its
 * rename; the age rule also recovers a leftover whose pid number was reused by
 * an unrelated process.
 */
export async function sweepStaging(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const now = Date.now();
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
      const pid = stagingPid(name);
      const stale = now - stats.mtimeMs > STAGING_MAX_AGE_MS;
      if (pid !== undefined && isProcessAlive(pid) && !stale) {
        continue;
      }
      await rm(path, { force: true });
    } catch {
      // Best effort; the next generate sweeps again.
    }
  }
}
