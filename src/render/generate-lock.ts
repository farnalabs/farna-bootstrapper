import { constants } from 'node:fs';
import { type FileHandle, open, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { GENERATE_LOCK_PATH, GENERATE_LOCK_STALE_MS, ROOT_DIR } from '../core/constants.js';
import { invalidConfig } from '../core/errors.js';

/**
 * The exclusive run lock that makes two concurrent `generate` runs impossible.
 *
 * Both runs would read the same lockfile, plan from it, remove its orphans and
 * rewrite it; the second could delete a file the first had just written, or
 * commit a plan computed before the first changed the tree. The lock covers the
 * whole read → plan → remove → commit sequence, and a second live run is a typed
 * `F001` ("lock held"), never a silent interleave.
 *
 * The lock is local-only state: it is never committed, never a managed output,
 * and is released in a `finally` even when the run fails. A lock whose owner pid
 * is no longer alive (a killed run) is stale and is reclaimed; the age bound
 * covers pid reuse after a reboot.
 */

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

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

type LockState = { kind: 'held' } | { kind: 'stale' } | { kind: 'unknown' };

async function readLockState(path: string, staleMs: number): Promise<LockState> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    // The path vanished between the failed exclusive create and this read: the
    // holder released it, so the caller may retry the create.
    return errorCode(error) === 'ENOENT' ? { kind: 'stale' } : { kind: 'unknown' };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return { kind: 'unknown' };
    }
    const pid = Number.parseInt((await handle.readFile('utf8')).trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      // The owner may be between creating the file and writing its pid. A
      // truncated or empty lock is only stale once it is older than the grace
      // window, so a concurrent create is never mistaken for a crash.
      return Date.now() - stats.mtimeMs > Math.min(staleMs, 60_000)
        ? { kind: 'stale' }
        : { kind: 'unknown' };
    }
    if (!isProcessAlive(pid)) {
      return { kind: 'stale' };
    }
    return Date.now() - stats.mtimeMs > staleMs ? { kind: 'stale' } : { kind: 'held' };
  } finally {
    await handle.close();
  }
}

async function createLock(path: string, subject: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') {
      // No `.farna` directory: the config load reports the missing source.
      return undefined;
    }
    if (code === 'EEXIST') {
      throw error;
    }
    throw invalidConfig(`cannot create the generate lock (${code ?? 'unknown error'})`, {
      subject,
      action: 'make .farna writable and re-run generate',
      cause: error,
    });
  }
}

async function releaseLock(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

/**
 * Run `body` while holding `.farna/.generate.lock`. A missing source root skips
 * the lock and runs `body`, which then reports the real problem.
 */
export async function withGenerateLock<T>(
  repoRoot: string,
  body: () => Promise<T>,
  staleMs: number = GENERATE_LOCK_STALE_MS,
): Promise<T> {
  const subject = GENERATE_LOCK_PATH;
  const path = join(repoRoot, ROOT_DIR, basename(GENERATE_LOCK_PATH));
  let handle: FileHandle | undefined;
  try {
    handle = await createLock(path, subject);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      throw error;
    }
    const state = await readLockState(path, staleMs);
    if (state.kind !== 'stale') {
      throw invalidConfig('another generate is already running', {
        subject,
        action:
          'wait for it to finish and re-run generate; delete the lock only when no generate is running',
      });
    }
    await releaseLock(path);
    try {
      handle = await createLock(path, subject);
    } catch (retry) {
      if (errorCode(retry) !== 'EEXIST') {
        throw retry;
      }
      throw invalidConfig('another generate started while this one reclaimed a stale lock', {
        subject,
        action: 'wait for it to finish and re-run generate',
        cause: retry,
      });
    }
  }
  if (handle === undefined) {
    // No `.farna` directory: nothing to hold, and the body reports why.
    return await body();
  }

  try {
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    return await body();
  } finally {
    await handle.close().catch(() => undefined);
    await releaseLock(path);
  }
}
