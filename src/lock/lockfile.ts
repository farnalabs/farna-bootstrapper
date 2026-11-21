import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedSource } from '../compose/resolve.js';
import {
  LOCK_FILE,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  ROOT_DIR,
  SCHEMA_VERSION,
  type Severity,
  type WarningCode,
} from '../core/constants.js';
import { canonicalJsonFile, compareCodepoints, sha256Hex } from '../core/json.js';
import type { RendererIdentity } from '../render/port.js';

export type LockFileEntry = {
  path: string;
  sha256: string;
  size: number;
};

export type LockResource = {
  kind: 'rule' | 'permission';
  id: string;
  sha256: string;
  /** The persona in the composition chain that contributed the resource. */
  fromPersona: string;
};

export type LockPersona = {
  id: string;
  /** Present when the persona composes a base persona. */
  extends?: string;
  digest: string;
  permissionDigest: string;
  resources: LockResource[];
};

export type LockWarning = {
  code: WarningCode;
  severity: Severity;
  persona: string;
  target: string;
  capability?: 'rule' | 'permission' | 'model';
  message: string;
};

export type Lockfile = {
  schemaVersion: 1;
  product: { name: string; version: string };
  target: string;
  mode: 'agent';
  renderer: RendererIdentity;
  personas: LockPersona[];
  files: LockFileEntry[];
  warnings: LockWarning[];
};

export type RenderedFile = {
  /** Repository-relative path. */
  path: string;
  bytes: string;
};

/**
 * Build the manifest of managed files. The composed persona records its base,
 * its resolved resource ids and its permission digest; every value is derived,
 * never timestamped.
 */
export function buildLockfile(
  source: ResolvedSource,
  renderer: RendererIdentity,
  files: RenderedFile[],
): Lockfile {
  const personas = source.personas
    .map((persona) => ({
      id: persona.id,
      ...(persona.extends === undefined ? {} : { extends: persona.extends }),
      digest: persona.digest,
      permissionDigest: persona.permissionDigest,
      resources: persona.resources.map((resource) => ({
        kind: resource.kind,
        id: resource.id,
        sha256: resource.sha256,
        fromPersona: resource.fromPersona,
      })),
    }))
    .sort((a, b) => compareCodepoints(a.id, b.id));
  return {
    schemaVersion: SCHEMA_VERSION,
    product: { name: PRODUCT_NAME, version: PRODUCT_VERSION },
    target: source.target,
    mode: 'agent',
    renderer,
    personas,
    files: files
      .map((file) => ({
        path: file.path,
        sha256: sha256Hex(file.bytes),
        size: Buffer.byteLength(file.bytes),
      }))
      .sort((a, b) => compareCodepoints(a.path, b.path)),
    warnings: source.warnings.map((entry) => ({
      code: entry.code,
      severity: entry.severity,
      persona: entry.persona,
      target: entry.target,
      ...(entry.capability === undefined ? {} : { capability: entry.capability }),
      message: entry.message,
    })),
  };
}

export function serialiseLockfile(lock: Lockfile): string {
  return canonicalJsonFile(lock);
}

/**
 * Read the committed lockfile only far enough to recover its renderer record.
 * A missing, unreadable or malformed lockfile returns `undefined`: the byte
 * comparison reports it as drift, and there is no identity to check.
 */
export async function readLockfile(repoRoot: string): Promise<Lockfile | undefined> {
  let text: string;
  try {
    text = await readFile(join(repoRoot, ROOT_DIR, LOCK_FILE), 'utf8');
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const renderer = (value as Record<string, unknown>)['renderer'];
  if (renderer === null || typeof renderer !== 'object' || Array.isArray(renderer)) {
    return undefined;
  }
  const record = renderer as Record<string, unknown>;
  if (typeof record['name'] !== 'string' || typeof record['version'] !== 'string') {
    return undefined;
  }
  if (record['integrity'] !== undefined && typeof record['integrity'] !== 'string') {
    return undefined;
  }
  return value as unknown as Lockfile;
}
