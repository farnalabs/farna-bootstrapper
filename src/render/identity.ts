import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { LOCKFILE_MAX_BYTES, NPM_LOCKFILE_MAX_BYTES, PRODUCT_NAME } from '../core/constants.js';
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

/**
 * The renderer's recorded integrity from one npm lock record.
 *
 * The record is searched, not indexed by one literal key: a nested install
 * records the renderer under the package that depends on it
 * (`node_modules/<product>/node_modules/<renderer>`), and reading only the
 * hoisted key made a present record look absent, so `generate` silently fell
 * back to the compile-time pin. When several entries match, the one nested
 * under our own package wins (that is the copy the product actually imports),
 * then the shallowest. The key itself breaks a remaining tie so the same record
 * always yields the same answer.
 *
 * Only an entry that is a JSON object with a string `integrity` counts. A
 * matching key with no readable integrity leaves the record without an answer,
 * exactly as an absent key did: the caller's bound and refusal rules decide
 * what a present-but-unverifiable record means.
 */
function integrityFromLock(lock: JsonObject | undefined, name: string): string | undefined {
  const packages = lock?.['packages'];
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    return undefined;
  }
  let best: { key: string; underProduct: boolean; level: number; integrity: string } | undefined;
  for (const [key, value] of Object.entries(packages as JsonObject)) {
    if (!isRendererKey(key, name)) {
      continue;
    }
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
  return best?.integrity;
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
    if (parent === current || basename(parent) !== 'node_modules') {
      break;
    }
    // `current` is inside a `node_modules` directory, so the package that owns
    // that directory is one level further out on the same chain.
    root = dirname(parent);
    current = root;
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
 * absent one and replaced by the compile-time pin.
 *
 * The project-lockfile walk stops at the install root (the top of the renderer's
 * `node_modules` chain, so a nested install reaches the project record) and
 * never reads an unrelated lockfile above it.
 *
 * @internal Exported so a test can prove the bound on an ancestor lockfile;
 * callers use `installedRendererIdentity`.
 */
export function readRecordedIntegrity(packageDir: string, name: string): string | undefined {
  const installRoot = installRootFor(packageDir);
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
    if (fromHidden !== undefined) {
      return fromHidden;
    }
  }
  let current = packageDir;
  for (;;) {
    const fromLock = integrityFromLock(readLockRecord(join(current, 'package-lock.json')), name);
    if (fromLock !== undefined) {
      return fromLock;
    }
    if (current === installRoot) {
      return undefined;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
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
