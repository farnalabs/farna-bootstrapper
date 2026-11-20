import type { ResolvedSource } from '../compose/resolve.js';
import { PRODUCT_NAME, PRODUCT_VERSION, SCHEMA_VERSION } from '../core/constants.js';
import { canonicalJsonFile, compareCodepoints, sha256Hex } from '../core/json.js';
import type { RendererIdentity } from '../render/port.js';

export type LockFileEntry = {
  path: string;
  sha256: string;
  size: number;
};

export type LockPersona = {
  id: string;
  digest: string;
  resources: Array<{ kind: 'rule'; id: string; sha256: string }>;
};

export type Lockfile = {
  schemaVersion: 1;
  product: { name: string; version: string };
  target: string;
  mode: 'agent';
  renderer: RendererIdentity;
  personas: LockPersona[];
  files: LockFileEntry[];
};

export type RenderedFile = {
  /** Repository-relative path. */
  path: string;
  bytes: string;
};

/** Build the manifest of managed files. Every value is derived, never timestamped. */
export function buildLockfile(
  source: ResolvedSource,
  renderer: RendererIdentity,
  files: RenderedFile[],
): Lockfile {
  const personas = source.personas
    .map((persona) => ({
      id: persona.id,
      digest: persona.digest,
      resources: persona.rules.map((rule) => ({
        kind: 'rule' as const,
        id: rule.id,
        sha256: rule.sha256,
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
  };
}

export function serialiseLockfile(lock: Lockfile): string {
  return canonicalJsonFile(lock);
}
