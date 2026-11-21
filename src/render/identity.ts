import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { LOCKFILE_MAX_BYTES, NPM_LOCKFILE_MAX_BYTES, PRODUCT_NAME } from '../core/constants.js';
import { FarnaError, rendererMismatch } from '../core/errors.js';
import type { RecordedIntegrity, RendererIdentity } from './port.js';

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
 * - no record at all (`ENOENT`) yields `undefined`, which `readRecordedIntegrity`
 *   reports as `no-record` so the renderer identity policy can name it with
 *   W114 rather than substituting the pin for the missing digest;
 * - a record over `NPM_LOCKFILE_MAX_BYTES` is refused (F010), naming the record
 *   and the bound, because a present-but-unverifiable integrity must fail
 *   exactly like a differing one rather than become a pass;
 * - a record that exists but cannot be read (a symlink, a FIFO, an I/O or parse
 *   failure, a non-object) is refused the same way.
 *
 * The bound is applied before any allocation: this is the one synchronous read
 * of a repository-controlled path, so it cannot use `readBoundedBytes`. It is
 * `NPM_LOCKFILE_MAX_BYTES`, not the small derived-lockfile bound, because npm's
 * record scales with the dependency tree and a legitimate monorepo lockfile can
 * be several megabytes.
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
    if (stats.size > NPM_LOCKFILE_MAX_BYTES) {
      throw rendererMismatch(
        `${path} is ${stats.size} bytes, over the ${NPM_LOCKFILE_MAX_BYTES}-byte bound for an npm lock record; it is refused rather than read, so the installed renderer's integrity cannot be verified`,
        {
          subject: path,
          action:
            'inspect the lock record for runaway content and restore it from version control; the bound is far above any real lockfile, so this is not a normal install',
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

/**
 * True when an npm `packages` key names the renderer: the key is
 * `node_modules/<name>` for a hoisted entry, or ends with
 * `/node_modules/<name>` for one nested under another package. npm writes the
 * key in exactly this shape, so the nested layout
 * (`npm install --install-strategy=nested`, which records
 * `node_modules/farna-bootstrapper/node_modules/rulesync`) is the same package
 * record one path deeper rather than a missing one.
 */
function isRendererKey(key: string, name: string): boolean {
  const hoisted = `node_modules/${name}`;
  return key === hoisted || key.endsWith(`/${hoisted}`);
}

/** True when a `packages` key nests the renderer directly under our own package. */
function isUnderProduct(key: string, name: string): boolean {
  const underProduct = `node_modules/${PRODUCT_NAME}/node_modules/${name}`;
  return key === underProduct || key.endsWith(`/${underProduct}`);
}

/** How many `node_modules` segments a `packages` key contains. Shallowest wins ties. */
function nestingLevel(key: string): number {
  return key.split('/').filter((segment) => segment === 'node_modules').length;
}

type LockLookup = { found: boolean; integrity?: string };

/**
 * The renderer's recorded integrity from one npm lock record.
 *
 * The record is searched, not indexed by one literal key: a nested install
 * records the renderer under the package that depends on it
 * (`node_modules/<product>/node_modules/<renderer>`), and reading only the
 * hoisted key made a present record look absent. When several entries match,
 * the one nested under our own package wins (that is the copy the product
 * actually imports), then the shallowest. The key itself breaks a remaining tie
 * so the same record always yields the same answer.
 *
 * `found` distinguishes the two ways a record can leave the integrity unknown:
 * no matching key at all, and a matching key whose value is not a JSON object
 * with a string `integrity`. The renderer identity policy reports both as
 * `W114`, but the warning names which one happened.
 */
function integrityFromLock(lock: JsonObject | undefined, name: string): LockLookup {
  const packages = lock?.['packages'];
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    return { found: false };
  }
  let found = false;
  let best: { key: string; underProduct: boolean; level: number; integrity: string } | undefined;
  for (const [key, value] of Object.entries(packages as JsonObject)) {
    if (!isRendererKey(key, name)) {
      continue;
    }
    found = true;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const integrity = (value as JsonObject)['integrity'];
    if (typeof integrity !== 'string') {
      continue;
    }
    const candidate = { key, underProduct: isUnderProduct(key, name), level: nestingLevel(key) };
    if (
      best === undefined ||
      (candidate.underProduct && !best.underProduct) ||
      (candidate.underProduct === best.underProduct &&
        (candidate.level < best.level ||
          (candidate.level === best.level && candidate.key < best.key)))
    ) {
      best = { ...candidate, integrity };
    }
  }
  return best === undefined ? { found } : { found: true, integrity: best.integrity };
}

/**
 * The install root that bounds the project-lockfile walk: the package at the
 * top of the renderer's `node_modules` chain. In a hoisted install the renderer
 * is at `<root>/node_modules/<renderer>`, so that is `<root>`, the directory
 * holding the project's `package-lock.json`.
 *
 * The climb follows the chain to its end rather than stopping at the first
 * package that owns a `node_modules`. In a nested install
 * (`npm install --install-strategy=nested`) the renderer's own package also
 * owns a `node_modules`, so `<root>/node_modules/<product>/node_modules/<renderer>`
 * is reached by hopping `<renderer> -> <product> -> <root>`; the project
 * lockfile that records the renderer, keyed
 * `node_modules/<product>/node_modules/<renderer>`, sits at that last hop.
 *
 * A scoped package adds one directory level between the package and its
 * `node_modules` (`<root>/node_modules/@scope/<name>`), so the scope directory
 * is skipped in the same climb; without that, a scoped install's project
 * lockfile was never reached and a present record looked absent.
 *
 * The walk must not climb above this boundary. An unrelated `package-lock.json`
 * in a parent directory (a home directory, a parent monorepo) would otherwise
 * be read as though it described this install and could refuse a healthy
 * project. Climbing only out of `node_modules` directories stops exactly at the
 * install root: a parent monorepo above the project is never entered, because
 * the project is not inside that monorepo's `node_modules`. When the package is
 * not inside any `node_modules` directory, only the working tree bounds the
 * walk; a package outside it is bounded by itself, so no unrelated parent record
 * is consulted.
 */
function installRootFor(packageDir: string): string {
  let root = packageDir;
  for (let current = packageDir; ; ) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    if (basename(parent) === 'node_modules') {
      // `current` is inside a `node_modules` directory, so the package that
      // owns that directory is one level further out on the same chain.
      root = dirname(parent);
      current = root;
      continue;
    }
    if (basename(parent).startsWith('@') && basename(dirname(parent)) === 'node_modules') {
      // A scoped package: `<root>/node_modules/@scope/<name>`. The scope
      // directory is part of the package path, not an install boundary.
      root = dirname(dirname(parent));
      current = root;
      continue;
    }
    break;
  }
  if (root !== packageDir) {
    return root;
  }
  const cwd = process.cwd();
  const fromCwd = relative(cwd, packageDir);
  if (fromCwd !== '' && !fromCwd.startsWith('..') && !isAbsolute(fromCwd)) {
    return cwd;
  }
  return packageDir;
}

/**
 * npm records the tarball integrity in `node_modules/.package-lock.json`; a
 * project lockfile is the fallback for layouts that do not write the hidden
 * one. Both are searched for the renderer's entry, including one nested under
 * our own package (see `integrityFromLock`). Only a record that does not exist
 * is skipped: a present record that cannot be read, or is over
 * `NPM_LOCKFILE_MAX_BYTES`, is refused with F010 instead of being treated as an
 * absent one; only a genuinely absent entry is W114.
 *
 * The project-lockfile walk stops at the install root (the top of the renderer's
 * `node_modules` chain, so a nested install reaches the project record) and
 * never reads an unrelated lockfile above it.
 *
 * The result is structured, never `undefined` for both "no record" and "no
 * usable entry". The renderer identity policy reports those as `W114` and names
 * which one happened, so they must not be indistinguishable at this seam.
 * A record that exists but cannot be read, or is above the bound, still throws
 * `F010`: only a genuinely absent entry is a warning.
 *
 * @internal Exported so a test can prove the bound on an ancestor lockfile;
 * callers use `installedRendererIdentity`.
 */
export function readRecordedIntegrity(packageDir: string, name: string): RecordedIntegrity {
  const installRoot = installRootFor(packageDir);
  let sawEntry = false;
  // The hidden record beside the installed package first: it describes the
  // innermost `node_modules` the renderer was installed into. In every layout
  // npm writes its hidden lockfile at the install root, which is also read.
  const hiddenPaths = [
    join(dirname(packageDir), '.package-lock.json'),
    join(installRoot, 'node_modules', '.package-lock.json'),
  ];
  const seen = new Set<string>();
  for (const hiddenPath of hiddenPaths) {
    if (seen.has(hiddenPath)) {
      continue;
    }
    seen.add(hiddenPath);
    const fromHidden = integrityFromLock(readLockRecord(hiddenPath), name);
    if (fromHidden.integrity !== undefined) {
      return { verified: true, integrity: fromHidden.integrity };
    }
    sawEntry = sawEntry || fromHidden.found;
  }
  let current = packageDir;
  for (;;) {
    const fromLock = integrityFromLock(readLockRecord(join(current, 'package-lock.json')), name);
    if (fromLock.integrity !== undefined) {
      return { verified: true, integrity: fromLock.integrity };
    }
    sawEntry = sawEntry || fromLock.found;
    if (current === installRoot) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return sawEntry
    ? { verified: false, reason: 'no-integrity' }
    : { verified: false, reason: 'no-record' };
}

/**
 * The structured integrity record for an identity. The real target attaches the
 * npm lookup directly; an injected target that only supplied `integrity` has a
 * present value treated as verified and a missing one as no record. This keeps
 * the warning decision in one place instead of re-deriving it at each caller.
 */
export function integrityRecordOf(identity: RendererIdentity): RecordedIntegrity {
  if (identity.integrityRecord !== undefined) {
    return identity.integrityRecord;
  }
  return identity.integrity === undefined
    ? { verified: false, reason: 'no-record' }
    : { verified: true, integrity: identity.integrity };
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
  const integrityRecord = readRecordedIntegrity(packageDir, name);
  return {
    name,
    version,
    integrityRecord,
    ...(integrityRecord.verified ? { integrity: integrityRecord.integrity } : {}),
  };
}

/**
 * Compare the renderer recorded in the lockfile with the one that is installed.
 *
 * A differing name or version always fails, and so does a lockfile that records
 * no integrity: the committed bytes must be tied to a pinned renderer. An
 * installed package whose npm lock record supplied no string integrity is not a
 * mismatch: its version has already been enforced, and the caller reports the
 * unverified digest as `W114_RENDERER_INTEGRITY_UNVERIFIED` rather than
 * refusing a normal global or linked install. When an integrity was read, it is
 * compared exactly; the check never degrades a known integrity to a
 * version-only comparison.
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
  const installedRecord = integrityRecordOf(installed);
  if (!installedRecord.verified) {
    // Not a refusal: the version matched, and `prepareRender` names the
    // unverified integrity as W114. An unknown integrity must not be compared
    // to anything, and must not be silently treated as a pass either.
    return;
  }
  if (recorded.integrity !== installedRecord.integrity) {
    throw rendererMismatch(
      `the lockfile records ${recorded.name} integrity ${recorded.integrity} but the installed package is ${installedRecord.integrity}`,
      {
        subject,
        action:
          're-install dependencies from the lockfile, or re-run generate to record the installed renderer',
      },
    );
  }
}
