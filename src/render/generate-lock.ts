import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { GENERATE_LOCK_PATH, GENERATE_LOCK_STALE_MS, ROOT_DIR } from '../core/constants.js';
import { invalidConfig } from '../core/errors.js';
import { describeFsError } from '../core/fs.js';
import { assertRealDirectory, lstatOrUndefined } from '../core/paths.js';

/**
 * The exclusive run lock that makes two concurrent `generate` runs impossible.
 *
 * Both runs would read the same lockfile, plan from it, remove its orphans and
 * rewrite it; the second could delete a file the first had just written, or
 * commit a plan computed before the first changed the tree. The lock covers the
 * whole read → plan → remove → commit sequence, and a second live run is a typed
 * `F001` ("lock held"), never a silent interleave.
 *
 * The lock is a **directory**, because `mkdir` is atomic on every supported
 * filesystem, including network shares where an exclusive create is not
 * reliable. Its owner writes `pid` inside it. The lock is local-only state: it
 * is never committed, never a managed output, and is released in a `finally`
 * even when the run fails.
 */

/** The file inside the lock directory that records the owning process. */
const PID_FILE = 'pid';
const RECLAIM_INFIX = '.reclaim.';
const RELEASE_INFIX = '.release.';

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not ours: still alive.
    return errorCode(error) === 'EPERM';
  }
}

function heldError(action: string, cause?: unknown): ReturnType<typeof invalidConfig> {
  return invalidConfig('another generate is already running', {
    subject: GENERATE_LOCK_PATH,
    action,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Inspect an existing lock directory. `held` when its owner is alive and the
 * lock is younger than the age bound; `stale` when the pid is dead or the lock
 * is older; `unknown` when the pid file is not readable yet (a concurrent
 * create may still be writing it).
 *
 * A path that is not a directory is a typed error, never "another generate is
 * running": the reader must not have to guess whether a file at the lock path
 * is a live holder or a broken tree.
 */
async function readLockState(path: string, staleMs: number): Promise<'held' | 'stale' | 'unknown'> {
  const stats = await lstatOrUndefined(path, GENERATE_LOCK_PATH);
  if (stats === undefined) {
    // The holder released it between the failed `mkdir` and this read.
    return 'stale';
  }
  if (!stats.isDirectory()) {
    throw invalidConfig(`${GENERATE_LOCK_PATH} is not a directory`, {
      subject: GENERATE_LOCK_PATH,
      action: 'remove the file at that path; the generate lock is a directory',
    });
  }
  let pid: number | undefined;
  try {
    const text = await readFile(join(path, PID_FILE), 'utf8');
    const parsed = Number.parseInt(text.trim(), 10);
    pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    pid = undefined;
  }
  if (pid === undefined) {
    // The owner may be between creating the directory and writing its pid. A
    // lock with no readable pid is only stale once it is older than the grace
    // window, so a concurrent create is never mistaken for a crash.
    return Date.now() - stats.mtimeMs > Math.min(staleMs, 60_000) ? 'stale' : 'unknown';
  }
  if (!isProcessAlive(pid)) {
    return 'stale';
  }
  return Date.now() - stats.mtimeMs > staleMs ? 'stale' : 'held';
}

/**
 * Move a stale lock aside and delete it. Only one reclaimer can succeed: the
 * `rename` of one source to one destination is atomic, so every other racer
 * fails with `ENOENT` and retries the `mkdir` instead of deleting a lock the
 * winner has already replaced.
 */
async function reclaim(path: string): Promise<void> {
  const aside = `${path}${RECLAIM_INFIX}${randomUUID()}`;
  try {
    await rename(path, aside);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return;
    }
    throw invalidConfig('cannot reclaim a stale generate lock', {
      subject: GENERATE_LOCK_PATH,
      action: 'remove the stale lock directory deliberately, then re-run generate',
      cause: error,
    });
  }
  await rm(aside, { recursive: true, force: true }).catch(() => undefined);
}

async function acquire(path: string, staleMs: number): Promise<void> {
  try {
    await mkdir(path, { mode: 0o755 });
    return;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') {
      // `.farna` is validated before the lock is taken, so this is a race that
      // removed it; the caller's body reports the missing source.
      return;
    }
    if (code !== 'EEXIST') {
      throw invalidConfig(`cannot create the generate lock (${code ?? 'unknown error'})`, {
        subject: GENERATE_LOCK_PATH,
        action: 'make .farna writable and re-run generate',
        cause: error,
      });
    }
  }
  const state = await readLockState(path, staleMs);
  if (state === 'held') {
    throw heldError(
      'wait for it to finish and re-run generate; delete the lock only when no generate is running',
    );
  }
  if (state === 'unknown') {
    throw heldError('wait for it to finish and re-run generate');
  }
  await reclaim(path);
  try {
    await mkdir(path, { mode: 0o755 });
  } catch (retry) {
    if (errorCode(retry) === 'EEXIST') {
      throw heldError('wait for it to finish and re-run generate', retry);
    }
    throw invalidConfig(
      `cannot create the generate lock (${errorCode(retry) ?? 'unknown error'})`,
      {
        subject: GENERATE_LOCK_PATH,
        action: 'make .farna writable and re-run generate',
        cause: retry,
      },
    );
  }
}

/**
 * Release the lock by renaming it aside and deleting the renamed directory. A
 * rename that fails because the path is already gone is the normal already-
 * released case; any other cleanup failure is reported on stderr rather than
 * replacing the body's own diagnostic or claiming the lock is still held.
 */
async function release(path: string): Promise<void> {
  const aside = `${path}${RELEASE_INFIX}${randomUUID()}`;
  try {
    await rename(path, aside);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      process.stderr.write(
        `farna-bootstrapper: warning: could not release ${GENERATE_LOCK_PATH} (${describeFsError(error)})\n`,
      );
    }
    return;
  }
  try {
    await rm(aside, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(
      `farna-bootstrapper: warning: could not remove the released lock (${describeFsError(error)})\n`,
    );
  }
}

/**
 * Run `body` while holding `.farna/.generate.lock`.
 *
 * The source root is validated **before** the lock is taken, so a `.farna` that
 * is a symlink, a file or absent reports the source problem rather than a lock
 * error the user cannot act on. A missing `.farna` skips the lock and runs
 * `body`, which reports the real problem.
 */
export async function withGenerateLock<T>(
  repoRoot: string,
  body: () => Promise<T>,
  staleMs: number = GENERATE_LOCK_STALE_MS,
): Promise<T> {
  const rootStats = await assertRealDirectory(join(repoRoot, ROOT_DIR), ROOT_DIR);
  if (rootStats === undefined) {
    // No `.farna` directory: nothing to hold, and the body reports why.
    return await body();
  }
  const path = join(repoRoot, ROOT_DIR, basename(GENERATE_LOCK_PATH));
  await acquire(path, staleMs);
  try {
    await writeFile(join(path, PID_FILE), `${process.pid}\n`, 'utf8');
    return await body();
  } finally {
    await release(path);
  }
}
