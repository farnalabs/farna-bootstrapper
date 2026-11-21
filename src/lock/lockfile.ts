import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { type ZodError, z } from 'zod';
import type { ResolvedSource } from '../compose/resolve.js';
import {
  type Capability,
  LOCK_FILE,
  LOCK_PATH,
  LOCKFILE_MAX_BYTES,
  MODE_AGENT,
  MODE_PROFILE,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  RENDER_MODES,
  type RenderMode,
  ROOT_DIR,
  SCHEMA_VERSION,
  type Severity,
  WARNING_CODES,
  type WarningCode,
} from '../core/constants.js';
import { type FarnaError, invalidConfig, pathUnsafe } from '../core/errors.js';
import { decodeUtf8 } from '../core/fs.js';
import { canonicalJsonFile, compareCodepoints, sha256Hex } from '../core/json.js';
import { assertRealDirectory, assertRealFile } from '../core/paths.js';
import { hasControlCharacters } from '../core/text.js';
import type { Warning } from '../report/warnings.js';

/**
 * The ownership shape of a managed path. A `structured` file is merged key by
 * key, so its entry describes the owned subset rather than the whole file.
 */
export type LockEntryShape = 'whole' | 'tree' | 'structured' | 'region';

export type LockFileEntry = {
  /** Repository-relative, POSIX-spelled, control-character-free. */
  path: string;
  /**
   * The digest whose match proves the bytes are still ours. For a `whole` or
   * `tree` file it is the whole file; for a `structured` file it is the
   * canonical owned subset, because the rest of that file is the user's.
   */
  sha256: string;
  /** The byte length of the thing `sha256` describes. */
  size: number;
  shape?: LockEntryShape | undefined;
  /** The top-level keys this tool owns, for a `structured` file. */
  ownedKeys?: string[] | undefined;
};

export type LockResource = {
  kind: 'rule' | 'permission' | 'mcp' | 'skill' | 'command' | 'hook';
  id: string;
  sha256: string;
  /** The persona in the composition chain that contributed the resource. */
  fromPersona: string;
};

export type LockPersona = {
  id: string;
  /** Present when the persona composes a base persona. */
  extends?: string | undefined;
  digest: string;
  permissionDigest: string;
  resources: LockResource[];
};

export type LockWarning = {
  code: WarningCode;
  severity: Severity;
  persona: string;
  target: string;
  capability?: Capability | undefined;
  message: string;
};

/** The lockfile's renderer record requires an integrity; the reader enforces it. */
export type LockfileRenderer = { name: string; version: string; integrity: string };

export type RenderedFile = {
  /** Repository-relative path. */
  path: string;
  bytes: string;
  /** The ownership shape, when it is not a whole file. */
  shape?: LockEntryShape;
  /** The owned top-level keys, for a `structured` file. */
  ownedKeys?: string[];
  /** The digest of the owned subset, for a `structured` file. */
  ownedSha256?: string;
  /** The byte length of the owned subset, for a `structured` file. */
  ownedSize?: number;
};

/** The validated and normalised whole document. Every field the reader consumes is checked. */
export type Lockfile = {
  schemaVersion: typeof SCHEMA_VERSION;
  product: { name: string; version: string };
  target: string;
  /** `agent` (every persona live) or `profile` (the active persona owns the workspace). */
  mode: RenderMode;
  /** The persona selected by `targets.<t>.active` or `--persona`; null in agent mode. */
  activePersona: string | null;
  renderer: { name: string; version: string; integrity?: string | undefined };
  /** Digest of the config plus every persona and resource file. */
  configDigest?: string | undefined;
  personas: LockPersona[];
  /** Personas resolved but not live. Empty in agent mode; absent in a legacy lockfile. */
  notLive: string[];
  files: LockFileEntry[];
  warnings: LockWarning[];
};

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lower-case SHA-256 hex digest');

const lockResourceSchema = z.strictObject({
  kind: z.enum(['rule', 'permission', 'mcp', 'skill', 'command', 'hook']),
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
  capability: z.enum(['rule', 'mcp', 'skill', 'command', 'permission', 'hook', 'model']).optional(),
  message: z.string().min(1),
});

/**
 * A managed path from a document a user could hand-edit. The reader is the
 * boundary: a path with a control character, an absolute path, a backslash or a
 * `..` segment is refused before it can reach a filesystem call or a terminal.
 */
function isSafeManagedPath(path: string): boolean {
  return (
    path.length > 0 &&
    !hasControlCharacters(path) &&
    !path.includes('\\') &&
    !path.startsWith('/') &&
    !path.split('/').includes('..') &&
    path !== '.'
  );
}

const managedPathSchema = z
  .string()
  .refine(isSafeManagedPath, 'must be a relative, escape-free, control-character-free path');

const lockFileEntrySchema = z
  .strictObject({
    path: managedPathSchema,
    sha256: sha256Schema,
    size: z.number().int().nonnegative(),
    shape: z.enum(['whole', 'tree', 'structured', 'region']).optional(),
    ownedKeys: z.array(z.string().min(1)).optional(),
  })
  .superRefine((entry, context) => {
    if (entry.shape === 'structured') {
      if (entry.ownedKeys === undefined || entry.ownedKeys.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['ownedKeys'],
          message: 'a structured entry names the keys it owns',
        });
      }
      return;
    }
    if (entry.ownedKeys !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['ownedKeys'],
        message: 'only a structured entry owns keys',
      });
    }
  });

/**
 * The document as it may appear on disk. `mode` and `activePersona` are optional
 * here so a lockfile written before profile mode existed still parses: treating
 * a present-but-older lockfile as absent discarded the recorded path set, which
 * skipped orphan removal and let a removed persona's artefacts stay live while
 * `check` reported clean. A present document is either understood or refused
 * with a typed error; it is never silently ignored.
 */
export const lockfileDocumentSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  product: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  target: z.string().min(1),
  mode: z.enum(RENDER_MODES).optional(),
  /** The persona selected by `targets.<t>.active` or `--persona`; null in agent mode. */
  activePersona: z.string().min(1).nullable().optional(),
  renderer: z.strictObject({
    name: z.string().min(1),
    version: z.string().min(1),
    // Written by every current build, but optional in the schema so a legacy
    // lockfile is read and then refused by the identity check (F010) rather
    // than silently treated as drift.
    integrity: z.string().min(1).optional(),
  }),
  configDigest: sha256Schema.optional(),
  personas: z.array(lockPersonaSchema),
  notLive: z.array(z.string().min(1)).optional(),
  files: z.array(lockFileEntrySchema),
  warnings: z.array(lockWarningSchema),
});

/**
 * Build the manifest of managed files. The composed persona records its base,
 * its resolved resource ids and its permission digest; every value is derived,
 * never timestamped. The renderer identity is the build's pin (see
 * `prepareRender`), so the bytes are identical on two machines with the same
 * source and toolchain.
 *
 * `warnings` is the source-derived warning set only. A renderer-level warning
 * (such as `W114_RENDERER_INTEGRITY_UNVERIFIED`) is evidence about the machine
 * that ran, not about the source, so `prepareRender` keeps it out of this
 * document: writing it here made a verified and an unverified machine produce
 * different lockfile bytes for the same source, and `check` reported drift for
 * a tree whose source had not changed. The command still reports it. The
 * lockfile does not list itself.
 *
 * A `structured` file records the digest and size of its owned subset, never of
 * the whole file: the rest of that file is the user's, and recording it would
 * make the lockfile depend on user content (two roots with the same source would
 * no longer produce identical bytes, and a foreign-key edit would look like
 * lockfile drift).
 */
export function buildLockfile(
  source: ResolvedSource,
  renderer: LockfileRenderer,
  files: RenderedFile[],
  warnings: readonly Warning[],
  derived: { configDigest: string; notLive: readonly string[] },
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
    mode: source.mode,
    activePersona: source.active,
    renderer,
    configDigest: derived.configDigest,
    personas,
    notLive: [...derived.notLive].sort(compareCodepoints),
    files: files
      .map((file) => {
        // A `structured` entry must name the keys it owns; the reader refuses
        // one with an empty `ownedKeys`. A file that declares the shape but owns
        // no key (the generated document has none of them) is recorded whole
        // instead, so everything this builder produces reads back. Any other
        // shape is carried through unchanged.
        const ownedStructured =
          file.shape === 'structured' && file.ownedKeys !== undefined && file.ownedKeys.length > 0;
        const shape: LockEntryShape | undefined = ownedStructured
          ? 'structured'
          : file.shape === 'structured'
            ? undefined
            : file.shape;
        return {
          path: file.path,
          sha256: ownedStructured
            ? (file.ownedSha256 ?? sha256Hex(file.bytes))
            : sha256Hex(file.bytes),
          size: ownedStructured
            ? (file.ownedSize ?? Buffer.byteLength(file.bytes))
            : Buffer.byteLength(file.bytes),
          ...(shape === undefined ? {} : { shape }),
          ...(ownedStructured && file.ownedKeys !== undefined ? { ownedKeys: file.ownedKeys } : {}),
        };
      })
      .sort((a, b) => compareCodepoints(a.path, b.path)),
    warnings: warnings.map((entry) => ({
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

/**
 * A present lockfile that cannot be understood. It is never reported as "no
 * records": doing that made orphan removal a no-op and rewrote a lockfile that
 * had forgotten every earlier path, while `check` called the tree clean.
 */
function malformedLockfile(detail: string): FarnaError {
  return invalidConfig(`${LOCK_PATH} ${detail}`, {
    subject: LOCK_PATH,
    action:
      'delete the lockfile and re-run generate; a lockfile is derived from the source and small',
  });
}

function describeLockIssue(error: ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return 'did not validate';
  }
  const pointer = issue.path.join('.');
  return pointer === '' ? issue.message : `${pointer}: ${issue.message}`;
}

function parseLockfileBytes(bytes: Uint8Array): Lockfile {
  let text: string;
  try {
    text = decodeUtf8(bytes, LOCK_PATH);
  } catch {
    throw malformedLockfile('is not valid UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformedLockfile('is not valid JSON');
  }
  const parsed = lockfileDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw malformedLockfile(`did not validate (${describeLockIssue(parsed.error)})`);
  }
  const document = parsed.data;
  // A legacy lockfile has neither field: it was written when every target was
  // in agent mode, so the honest normalisation is agent mode with no active
  // persona. A document that names profile mode must name the persona.
  const mode = document.mode ?? (document.activePersona != null ? MODE_PROFILE : MODE_AGENT);
  const activePersona = mode === MODE_PROFILE ? (document.activePersona ?? null) : null;
  if (mode === MODE_PROFILE && activePersona === null) {
    throw malformedLockfile('records profile mode without an active persona');
  }
  return {
    ...document,
    mode,
    activePersona,
    notLive: [...(document.notLive ?? [])].sort(compareCodepoints),
  };
}

/**
 * Read the committed lockfile and validate the whole document. `check` reads it
 * before comparing bytes, so it is guarded like any other input: `.farna` must
 * be a real directory and the lockfile a real regular file of bounded size,
 * opened with `O_NOFOLLOW`.
 *
 * Returns `undefined` only when the lockfile is absent. A lockfile that is
 * present but unreadable, malformed, or of an incompatible version is a typed
 * F001 naming `.farna/lock.json` and its recovery; it is never treated as "no
 * records". A symlink, a FIFO, a device node or an oversized file is a typed
 * F003 rather than a follow or a hang. Any other filesystem failure is a typed
 * F001 naming the repository path, never a raw `EACCES`.
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
      action:
        'make the lockfile readable, or delete it and re-run generate; a lockfile is derived from the source',
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

/** The lockfile entry recorded for one managed path, when there is one. */
export function recordedEntry(
  lockfile: Lockfile | undefined,
  path: string,
): LockFileEntry | undefined {
  return lockfile?.files.find((file) => file.path === path);
}
