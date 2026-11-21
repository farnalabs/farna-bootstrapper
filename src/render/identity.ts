import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { rendererMismatch } from '../core/errors.js';
import type { RendererIdentity } from './port.js';

/**
 * The renderer that actually ran. The values are read from the installed
 * package, never copied from a compiled-in literal: the lockfile's renderer
 * record must describe the bytes that produced the committed artefacts.
 */

const requireFromHere = createRequire(import.meta.url);

type JsonObject = Record<string, unknown>;

function readJson(path: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonObject)
      : undefined;
  } catch {
    return undefined;
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
 * one. The result is best-effort: a missing integrity omits the field rather
 * than inventing a value.
 */
function readIntegrity(packageDir: string, name: string): string | undefined {
  const hidden = readJson(join(dirname(packageDir), '.package-lock.json'));
  const fromHidden = integrityFromLock(hidden, name);
  if (fromHidden !== undefined) {
    return fromHidden;
  }
  let current = packageDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const fromLock = integrityFromLock(readJson(join(current, 'package-lock.json')), name);
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
  const integrity = readIntegrity(packageDir, name);
  return { name, version, ...(integrity === undefined ? {} : { integrity }) };
}

/**
 * Compare the renderer recorded in the lockfile with the one that is installed.
 * A differing name or version always fails, and so does a missing integrity on
 * either side: the check never silently degrades to a version comparison. The
 * lockfile records the build's pin, so this compares the installed package
 * against that pin.
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
