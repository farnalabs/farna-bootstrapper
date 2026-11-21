import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { LOCKFILE_MAX_BYTES } from '../core/constants.js';
import { FarnaError, rendererMismatch } from '../core/errors.js';
import type { RendererIdentity } from './port.js';

/**
 * The renderer that actually ran. The values are read from the installed
 * package, never copied from a compiled-in literal: the lockfile's renderer
 * record must describe the bytes that produced the committed artefacts.
 */

const requireFromHere = createRequire(import.meta.url);

type JsonObject = Record<string, unknown>;

/**
 * Read a JSON file best-effort. An absent, unreadable, oversized or malformed
 * file yields `undefined`, because this is used for `package.json` metadata the
 * caller reports as a typed refusal itself. Lock records are read through
 * `readLockRecord`, which never treats a present record as absent.
 */
function readJson(path: string): JsonObject | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > LOCKFILE_MAX_BYTES) {
      return undefined;
    }
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonObject)
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function isMissing(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** A lock record that exists but cannot be verified. Never a fallback. */
function unreadableLockRecord(path: string, cause?: unknown): FarnaError {
  const detail = cause instanceof Error ? `: ${cause.message}` : '';
  return rendererMismatch(
    `${path} exists but could not be read${detail}, so the installed renderer's integrity cannot be verified`,
    {
      subject: path,
      action:
        're-install dependencies so npm writes a readable lock record, or restore it from version control',
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/**
 * Read an npm lock record. The three outcomes are deliberately distinct:
 *
 * - no record at all (`ENOENT`) yields `undefined`, the one case where a global
 *   install's compile-time pin stands in for a missing integrity;
 * - a record over `LOCKFILE_MAX_BYTES` is refused (F010), naming the record and
 *   the bound, because a present-but-unverifiable integrity must fail exactly
 *   like a differing one rather than become a pass;
 * - a record that exists but cannot be read (a symlink, a FIFO, an I/O or parse
 *   failure, a non-object) is refused the same way.
 *
 * The bound is applied before any allocation: this is the one synchronous read
 * of a repository-controlled path, so it cannot use `readBoundedBytes`.
 */
function readLockRecord(path: string): JsonObject | undefined {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (cause) {
    if (isMissing(cause)) {
      return undefined;
    }
    throw unreadableLockRecord(path, cause);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw unreadableLockRecord(path, new Error('it is not a regular file'));
    }
    if (stats.size > LOCKFILE_MAX_BYTES) {
      throw rendererMismatch(
        `${path} is ${stats.size} bytes, over the ${LOCKFILE_MAX_BYTES}-byte bound for a lock record; it is refused rather than read, so the installed renderer's integrity cannot be verified`,
        {
          subject: path,
          action: 're-install dependencies so npm writes a lock record inside the bound',
        },
      );
    }
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw unreadableLockRecord(path, new Error('it is not a JSON object'));
    }
    return value as JsonObject;
  } catch (cause) {
    if (cause instanceof FarnaError) {
      throw cause;
    }
    throw unreadableLockRecord(path, cause);
  } finally {
    closeSync(fd);
  }
}

function findPackageDir(name: string): string {
  let entry: string;
  try {
    entry = requireFromHere.resolve(name);
  } catch (cause) {
    // A global install, or a missing dependency, must not surface a raw
    // module-resolution stack from a command that renders.
    throw rendererMismatch(`the pinned renderer ${name} is not installed`, {
      subject: name,
      action: 'install the pinned dependencies, or reinstall farna-bootstrapper',
      cause,
    });
  }
  let current = dirname(entry);
  for (let depth = 0; depth < 16; depth += 1) {
    const manifest = readJson(join(current, 'package.json'));
    if (manifest?.['name'] === name && typeof manifest['version'] === 'string') {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw rendererMismatch(`cannot locate the installed ${name} package`, {
    subject: name,
    action: 're-install dependencies so the pinned renderer is present',
  });
}

function integrityFromLock(lock: JsonObject | undefined, name: string): string | undefined {
  const packages = lock?.['packages'];
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    return undefined;
  }
  const entry = (packages as JsonObject)[`node_modules/${name}`];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return undefined;
  }
  const integrity = (entry as JsonObject)['integrity'];
  return typeof integrity === 'string' ? integrity : undefined;
}

/**
 * npm records the tarball integrity in `node_modules/.package-lock.json`; a
 * project lockfile is the fallback for layouts that do not write the hidden
 * one. Only a record that does not exist is skipped: a present record that
 * cannot be read, or is over `LOCKFILE_MAX_BYTES`, is refused with F010 instead
 * of being treated as an absent one and replaced by the compile-time pin.
 *
 * @internal Exported so a test can prove the bound on an ancestor lockfile;
 * callers use `installedRendererIdentity`.
 */
export function readRecordedIntegrity(packageDir: string, name: string): string | undefined {
  const hidden = readLockRecord(join(dirname(packageDir), '.package-lock.json'));
  const fromHidden = integrityFromLock(hidden, name);
  if (fromHidden !== undefined) {
    return fromHidden;
  }
  let current = packageDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const fromLock = integrityFromLock(readLockRecord(join(current, 'package-lock.json')), name);
    if (fromLock !== undefined) {
      return fromLock;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

/** Read the installed renderer's own package manifest and recorded integrity. */
export function installedRendererIdentity(name: string): RendererIdentity {
  const packageDir = findPackageDir(name);
  const manifest = readJson(join(packageDir, 'package.json'));
  const version = manifest?.['version'];
  if (manifest === undefined || typeof version !== 'string') {
    throw rendererMismatch(`the installed ${name} package has no readable version`, {
      subject: name,
      action: 're-install dependencies so the pinned renderer is present',
    });
  }
  const integrity = readRecordedIntegrity(packageDir, name);
  return { name, version, ...(integrity === undefined ? {} : { integrity }) };
}

/**
 * Compare the renderer recorded in the lockfile with the one that is installed.
 * A differing name or version always fails, and so does a missing integrity on
 * either side: the check never silently degrades to a version comparison. The
 * pinned target substitutes the compile-time pin for a global install that
 * recorded no npm integrity, so by the time this function runs a pinned renderer
 * always carries an integrity; an undefined one here means neither the install
 * nor a pin supplied it. The lockfile records the build's pin, so this compares
 * the installed package against that pin.
 */
export function verifyRendererIdentity(
  recorded: RendererIdentity,
  installed: RendererIdentity,
  subject = '.farna/lock.json',
): void {
  if (recorded.name !== installed.name) {
    throw rendererMismatch(
      `the lockfile records renderer "${recorded.name}" but "${installed.name}" is installed`,
      {
        subject,
        action: 'delete the lockfile and re-run generate to record the installed renderer',
      },
    );
  }
  if (recorded.version !== installed.version) {
    throw rendererMismatch(
      `the lockfile records ${recorded.name} ${recorded.version} but ${installed.version} is installed`,
      {
        subject,
        action: 'delete the lockfile and re-run generate to record the installed renderer',
      },
    );
  }
  if (recorded.integrity === undefined) {
    throw rendererMismatch(
      `the lockfile records no integrity for ${recorded.name} ${recorded.version}, so the committed bytes cannot be tied to a pinned renderer`,
      {
        subject,
        action: 'delete the lockfile and re-run generate to record the pinned renderer',
      },
    );
  }
  if (installed.integrity === undefined) {
    throw rendererMismatch(
      `the installed ${installed.name} ${installed.version} records no tarball integrity, so it cannot be checked against the lockfile`,
      {
        subject,
        action: 're-install dependencies with npm so the integrity is recorded',
      },
    );
  }
  if (recorded.integrity !== installed.integrity) {
    throw rendererMismatch(
      `the lockfile records ${recorded.name} integrity ${recorded.integrity} but the installed package is ${installed.integrity}`,
      {
        subject,
        action:
          're-install dependencies from the lockfile, or re-run generate to record the installed renderer',
      },
    );
  }
}
