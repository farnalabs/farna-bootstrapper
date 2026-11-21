import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ResolvedSource } from '../compose/resolve.js';
import {
  LOCK_FILE,
  LOCK_PATH,
  LOCKFILE_MAX_BYTES,
  MODE,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  ROOT_DIR,
  SCHEMA_VERSION,
  type Severity,
  WARNING_CODES,
  type WarningCode,
} from '../core/constants.js';
import { invalidConfig, pathUnsafe } from '../core/errors.js';
import { decodeUtf8 } from '../core/fs.js';
import { canonicalJsonFile, compareCodepoints, sha256Hex } from '../core/json.js';
import { assertRealDirectory, assertRealFile } from '../core/paths.js';

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

/** The lockfile's renderer record requires an integrity; the reader enforces it. */
export type LockfileRenderer = { name: string; version: string; integrity: string };

export type RenderedFile = {
  /** Repository-relative path. */
  path: string;
  bytes: string;
};

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lower-case SHA-256 hex digest');

const lockResourceSchema = z.strictObject({
  kind: z.enum(['rule', 'permission']),
  id: z.string().min(1),
  sha256: sha256Schema,
  fromPersona: z.string().min(1),
});

const lockPersonaSchema = z.strictObject({
  id: z.string().min(1),
  extends: z.string().min(1).optional(),
  digest: sha256Schema,
  permissionDigest: sha256Schema,
  resources: z.array(lockResourceSchema),
});

const lockWarningSchema = z.strictObject({
  code: z.enum(WARNING_CODES),
  severity: z.enum(['error', 'high', 'medium', 'low', 'info']),
  persona: z.string().min(1),
  target: z.string().min(1),
  capability: z.enum(['rule', 'permission', 'model']).optional(),
  message: z.string().min(1),
});

const lockFileEntrySchema = z.strictObject({
  path: z.string().min(1),
  sha256: sha256Schema,
  size: z.number().int().nonnegative(),
});

/**
 * The whole document, not one field. `check` trusts these values, so a field
 * the reader does not validate is a field it would consume unchecked.
 */
export const lockfileSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  product: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  target: z.string().min(1),
  mode: z.literal(MODE),
  renderer: z.strictObject({
    name: z.string().min(1),
    version: z.string().min(1),
    // Written by every current build, but optional in the schema so a legacy
    // lockfile is read and then refused by the identity check (F010) rather
    // than silently treated as drift.
    integrity: z.string().min(1).optional(),
  }),
  personas: z.array(lockPersonaSchema),
  files: z.array(lockFileEntrySchema),
  warnings: z.array(lockWarningSchema),
});

/** The validated whole document. Every field the reader consumes is checked. */
export type Lockfile = z.infer<typeof lockfileSchema>;

/**
 * Build the manifest of managed files. The composed persona records its base,
 * its resolved resource ids and its permission digest; every value is derived,
 * never timestamped. The renderer identity is the build's pin (see
 * `prepareRender`), so the bytes are identical on two machines with the same
 * source and toolchain. The lockfile does not list itself.
 */
export function buildLockfile(
  source: ResolvedSource,
  renderer: LockfileRenderer,
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
    mode: MODE,
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

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NO_BLOCK = constants.O_NONBLOCK ?? 0;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function parseLockfileBytes(bytes: Uint8Array): Lockfile | undefined {
  let text: string;
  try {
    text = decodeUtf8(bytes, LOCK_PATH);
  } catch {
    // A lockfile that is not valid UTF-8 is drift, not a crash: the byte
    // comparison reports it and there is no identity to trust.
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = lockfileSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Read the committed lockfile and validate the whole document. `check` reads it
 * before comparing bytes, so it is guarded like any other input: `.farna` must
 * be a real directory and the lockfile a real regular file of bounded size,
 * opened with `O_NOFOLLOW`.
 *
 * Returns `undefined` when the lockfile is missing, unreadable in a benign way,
 * or malformed; the byte comparison then reports drift. A symlink, a FIFO, a
 * device node or an oversized file is a typed F003 rather than a follow or a
 * hang. Any other filesystem failure is a typed F001 naming the repository
 * path, never a raw `EACCES`.
 */
export async function readLockfile(repoRoot: string): Promise<Lockfile | undefined> {
  const subject = LOCK_PATH;
  await assertRealDirectory(join(repoRoot, ROOT_DIR), ROOT_DIR);
  const path = join(repoRoot, ROOT_DIR, LOCK_FILE);
  const stats = await assertRealFile(path, subject);
  if (stats === undefined) {
    return undefined;
  }
  if (stats.size > LOCKFILE_MAX_BYTES) {
    throw pathUnsafe(`${subject} is larger than ${LOCKFILE_MAX_BYTES} bytes; refusing to read it`, {
      subject,
      action: 'delete the lockfile and re-run generate; a lockfile is derived and small',
    });
  }

  let handle: FileHandle;
  try {
    // O_NOFOLLOW closes the window between the lstat above and the open: a
    // symlink swapped in is refused (ELOOP), never followed.
    // O_NONBLOCK matters only in the race where the path becomes a FIFO after
    // the lstat: without it the open would block forever waiting for a writer.
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW | NO_BLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') {
      return undefined;
    }
    if (code === 'ELOOP') {
      throw pathUnsafe('symlink not allowed: .farna/lock.json', {
        subject,
        action: 'replace the symbolic link with a real file',
      });
    }
    throw invalidConfig(`cannot read ${subject}`, {
      subject,
      action: 'make the lockfile readable and re-run check',
      cause: error,
    });
  }

  try {
    // The open fd is authoritative: the path may have changed after the lstat.
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw pathUnsafe(`${subject} is not a regular file`, {
        subject,
        action: 'delete it and re-run generate; a lockfile is a regular file',
      });
    }
    if (opened.size > LOCKFILE_MAX_BYTES) {
      throw pathUnsafe(
        `${subject} is larger than ${LOCKFILE_MAX_BYTES} bytes; refusing to read it`,
        {
          subject,
          action: 'delete the lockfile and re-run generate; a lockfile is derived and small',
        },
      );
    }
    return parseLockfileBytes(await handle.readFile());
  } finally {
    await handle.close();
  }
}
