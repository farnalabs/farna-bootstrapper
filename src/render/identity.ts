import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
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

type Candidate = {
  key: string;
  underProduct: boolean;
  level: number;
  recordIndex: number;
  integrity: string;
};

/**
 * Rank two renderer entries. The entry nested under our own package wins (that
 * is the copy the product actually imports), then the shallowest, then the
 * earlier record, then the key, so the same records always yield the same
 * answer.
 */
function isBetterCandidate(candidate: Candidate, best: Candidate): boolean {
  if (candidate.underProduct !== best.underProduct) {
    return candidate.underProduct;
  }
  if (candidate.level !== best.level) {
    return candidate.level < best.level;
  }
  if (candidate.recordIndex !== best.recordIndex) {
    return candidate.recordIndex < best.recordIndex;
  }
  return candidate.key < best.key;
}

/**
 * The renderer's entry across the supported lock records.
 *
 * The `packages` map is searched for a key ending in `node_modules/<name>`, not
 * indexed by one literal key: a nested install records the renderer under the
 * package that depends on it
 * (`node_modules/<product>/node_modules/<renderer>`), and reading only the
 * hoisted key made a present record look absent. When several entries match,
 * the one nested under our own package wins, then the shallowest (see
 * `isBetterCandidate`).
 *
 * `found` distinguishes the two ways the records can leave the integrity
 * unknown: no matching key at all, and a matching key whose value is not a JSON
 * object with a string `integrity`. The renderer identity policy reports both
 * as `W114`, but the warning names which one happened.
 */
function bestRendererEntry(
  records: ReadonlyArray<JsonObject | undefined>,
  name: string,
): LockLookup {
  let found = false;
  let best: Candidate | undefined;
  records.forEach((record, recordIndex) => {
    const packages = record?.['packages'];
    if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
      return;
    }
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
      const candidate = {
        key,
        underProduct: isUnderProduct(key, name),
        level: nestingLevel(key),
        recordIndex,
        integrity,
      };
      if (best === undefined || isBetterCandidate(candidate, best)) {
        best = candidate;
      }
    }
  });
  return best === undefined ? { found } : { found: true, integrity: best.integrity };
}

/**
 * The install root: the top of the `node_modules` chain the renderer sits in,
 * which is also the nearest ancestor of the product package that owns a
 * `node_modules` directory. In a hoisted install the renderer is at
 * `<root>/node_modules/<renderer>`, so that is `<root>`, the directory holding
 * the install's records.
 *
 * The climb follows the chain to its end rather than stopping at the first
 * package that owns a `node_modules`. In a nested install
 * (`npm install --install-strategy=nested`) the renderer's own package also
 * owns a `node_modules`, so `<root>/node_modules/<product>/node_modules/<renderer>`
 * is reached by hopping `<renderer> -> <product> -> <root>`; the install's
 * records, keyed `node_modules/<product>/node_modules/<renderer>`, sit at that
 * last hop.
 *
 * A scoped package adds one directory level between the package and its
 * `node_modules` (`<root>/node_modules/@scope/<name>`), so the scope directory
 * is skipped in the same climb; without that, a scoped install's records were
 * never reached and a present record looked absent.
 *
 * The walk never climbs above this boundary, because it only leaves
 * `node_modules` directories. A workspace root, a parent monorepo or any other
 * ancestor outside that chain is never read, and a package that is not inside a
 * `node_modules` directory (a linked install) is bounded by itself.
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
  return root;
}

/**
 * The renderer's recorded integrity, from exactly two records at the install
 * root:
 *
 * 1. the hidden record npm writes beside the installed tree,
 *    `<installRoot>/node_modules/.package-lock.json`;
 * 2. the install root's lockfile, `<installRoot>/package-lock.json`.
 *
 * Nothing above the install root is read: a workspace root, a parent monorepo
 * or a sibling package may record a different copy of the renderer, and taking
 * its integrity refused a healthy install or verified one that was never
 * checked. Those layouts yield `W114` instead.
 *
 * Both records are read before the search, so a present record that cannot be
 * read, is not a regular file, is a symlink or is over the npm-record bound is
 * refused with `F010` even when the other record is usable. Only a genuinely
 * absent record is skipped, and only a genuinely absent renderer entry, or an
 * entry with no string integrity, is `W114`.
 *
 * The result is structured, never `undefined` for both "no record" and "no
 * usable entry". The renderer identity policy reports those as `W114` and names
 * which one happened, so they must not be indistinguishable at this seam.
 *
 * @internal Exported so a test can prove the bound on a supported record;
 * callers use `installedRendererIdentity`.
 */
export function readRecordedIntegrity(packageDir: string, name: string): RecordedIntegrity {
  const installRoot = installRootFor(packageDir);
  const records = [
    readLockRecord(join(installRoot, 'node_modules', '.package-lock.json')),
    readLockRecord(join(installRoot, 'package-lock.json')),
  ];
  const lookup = bestRendererEntry(records, name);
  if (lookup.integrity !== undefined) {
    return { verified: true, integrity: lookup.integrity };
  }
  return lookup.found
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
