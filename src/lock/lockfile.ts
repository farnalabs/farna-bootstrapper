import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { type ZodError, z } from 'zod';
import type { ResolvedSource } from '../compose/resolve.js';
import {
  type Capability,
  ID_MAX_LENGTH,
  ID_RE,
  LOCK_FILE,
  LOCK_PATH,
  LOCKFILE_MAX_BYTES,
  LOCKFILE_SCHEMA_VERSION,
  MODE_AGENT,
  MODE_PROFILE,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  RENDER_MODES,
  type RenderMode,
  ROOT_DIR,
  type Severity,
  TARGET_ENUM,
  WARNING_CODES,
  type WarningCode,
} from '../core/constants.js';
import { type FarnaError, invalidConfig, pathUnsafe } from '../core/errors.js';
import { decodeUtf8 } from '../core/fs.js';
import { canonicalJsonFile, compareCodepoints, sha256Hex } from '../core/json.js';
import { assertRealDirectory, assertRealFile } from '../core/paths.js';
import { hasControlCharacters } from '../core/text.js';
import { regionEntryKey } from '../render/region.js';
import type { Warning } from '../report/warnings.js';

/**
 * The ownership shape of a managed path. A `structured` file is merged key by
 * key and a `region` file by the body between two marker lines, so both entries
 * describe the owned subset rather than the whole file.
 */
export type LockEntryShape = 'whole' | 'tree' | 'structured' | 'region';

export type LockFileEntry = {
  /** Repository-relative, POSIX-spelled, control-character-free. */
  path: string;
  /**
   * The digest whose match proves the bytes are still ours. For a `whole` or
   * `tree` file it is the whole file; for a `structured` file it is the
   * canonical owned subset and for a `region` file the body between the
   * markers, because the rest of either file is the user's.
   */
  sha256: string;
  /** The byte length of the thing `sha256` describes. */
  size: number;
  shape?: LockEntryShape | undefined;
  /** The top-level keys this tool owns, for a `structured` file. */
  ownedKeys?: string[] | undefined;
  /** The region id this tool owns at `path`, for a `region` file. */
  regionId?: string | undefined;
};

/**
 * The key a recorded-set comparison uses. A path alone no longer identifies a
 * recorded file when two disjoint regions can share one path, so a region entry
 * is keyed by its path and id and every other shape by its path. `path` alone
 * stays the key for target ownership (`lockfileTargetOf`): one file has one
 * owning target.
 */
export type EntryKeyed = {
  path: string;
  shape?: LockEntryShape | undefined;
  regionId?: string | undefined;
};

export function entryKey(entry: EntryKeyed): string {
  return entry.shape === 'region' && entry.regionId !== undefined
    ? regionEntryKey(entry.path, entry.regionId)
    : entry.path;
}

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
  /**
   * The bytes to write. For a `region` file this is the **body** between the
   * markers, never the whole file: the surrounding bytes are the user's and a
   * merge preserves them.
   */
  bytes: string;
  /** The ownership shape, when it is not a whole file. */
  shape?: LockEntryShape;
  /** The owned top-level keys, for a `structured` file. */
  ownedKeys?: string[];
  /** The region id this file owns, for a `region` file. */
  regionId?: string;
  /** The digest of the owned subset or region body. */
  ownedSha256?: string;
  /** The byte length of the owned subset or region body. */
  ownedSize?: number;
};

/**
 * One target's record: the fields version 1 held at the top level, unchanged.
 * A version 2 document keys these by target id.
 */
export type LockTarget = {
  /** `agent` (every persona live) or `profile` (the active persona owns the workspace). */
  mode: RenderMode;
  /** The persona selected by `targets.<t>.active` or `--persona`; null in agent mode. */
  activePersona: string | null;
  /** Personas resolved but not live. Empty in agent mode. */
  notLive: string[];
  personas: LockPersona[];
  files: LockFileEntry[];
};

/**
 * The validated and normalised whole document. Every field the reader consumes
 * is checked. The in-memory shape is ALWAYS version 2: a version 1 document on
 * disk is normalised into one target entry, so every consumer sees one form.
 */
export type Lockfile = {
  schemaVersion: typeof LOCKFILE_SCHEMA_VERSION;
  /**
   * The version of the document this was read from, or 2 when freshly built. In
   * memory only: never serialised. `check` uses it to skip the lockfile byte
   * comparison for a version 1 document, which the next `generate` upgrades;
   * comparing those bytes would report the migration itself as drift.
   */
  readVersion: 1 | 2;
  product: { name: string; version: string };
  renderer: { name: string; version: string; integrity?: string | undefined };
  /** Digest of the config plus every persona and resource file, shared by every target. */
  configDigest?: string | undefined;
  /** One entry per target, keyed by target id. */
  targets: Record<string, LockTarget>;
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

/** The region id grammar is the persona and resource id grammar. */
const regionIdSchema = z
  .string()
  .max(ID_MAX_LENGTH, `must be at most ${ID_MAX_LENGTH} characters`)
  .regex(ID_RE, 'must be a lower-kebab-case id');

const lockFileEntrySchema = z
  .strictObject({
    path: managedPathSchema,
    sha256: sha256Schema,
    size: z.number().int().nonnegative(),
    shape: z.enum(['whole', 'tree', 'structured', 'region']).optional(),
    ownedKeys: z.array(z.string().min(1)).optional(),
    regionId: regionIdSchema.optional(),
  })
  .superRefine((entry, context) => {
    if (entry.shape === 'region') {
      if (entry.regionId === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['regionId'],
          message: 'a region entry names the region id it owns',
        });
      }
      if (entry.ownedKeys !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['ownedKeys'],
          message: 'only a structured entry owns keys',
        });
      }
      return;
    }
    if (entry.regionId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['regionId'],
        message: 'only a region entry names a region id',
      });
    }
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

const lockRendererSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  // Written by every current build, but optional in the schema so a legacy
  // lockfile is read and then refused by the identity check (F010) rather
  // than silently treated as drift.
  integrity: z.string().min(1).optional(),
});

const lockProductSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
});

/**
 * The version 1 document as it may appear on disk. `mode` and `activePersona`
 * are optional here so a lockfile written before profile mode existed still
 * parses: treating a present-but-older lockfile as absent discarded the
 * recorded path set, which skipped orphan removal and let a removed persona's
 * artefacts stay live while `check` reported clean. A present document is
 * either understood or refused with a typed error; it is never silently
 * ignored.
 */
export const lockfileDocumentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  product: lockProductSchema,
  /**
   * The target that produced the committed bytes. It is the closed set this
   * build renders: a lockfile naming anything else is not one this build can
   * re-render, and treating it as merely stale would let `check` compare a tree
   * against a target the config cannot select.
   */
  target: z.enum(TARGET_ENUM),
  mode: z.enum(RENDER_MODES).optional(),
  /** The persona selected by `targets.<t>.active` or `--persona`; null in agent mode. */
  activePersona: z.string().min(1).nullable().optional(),
  renderer: lockRendererSchema,
  configDigest: sha256Schema.optional(),
  personas: z.array(lockPersonaSchema),
  notLive: z.array(z.string().min(1)).optional(),
  files: z.array(lockFileEntrySchema),
  warnings: z.array(lockWarningSchema),
});

/**
 * One target entry of a version 2 document. Every key is one version 1 held at
 * the top level, so a migrated document records exactly what version 1 did.
 */
export const lockfileTargetSchema = z.strictObject({
  mode: z.enum(RENDER_MODES),
  activePersona: z.string().min(1).nullable(),
  notLive: z.array(z.string().min(1)),
  personas: z.array(lockPersonaSchema),
  files: z.array(lockFileEntrySchema),
});

/** The version 2 document this build writes. */
export const lockfileDocumentV2Schema = z.strictObject({
  schemaVersion: z.literal(LOCKFILE_SCHEMA_VERSION),
  product: lockProductSchema,
  renderer: lockRendererSchema,
  configDigest: sha256Schema.optional(),
  /**
   * Keyed by target id. Every key is a target this build renders, because a
   * lockfile naming anything else is not one this build can re-render.
   */
  targets: z.partialRecord(z.enum(TARGET_ENUM), lockfileTargetSchema),
  warnings: z.array(lockWarningSchema),
});

/**
 * The document as it may appear on disk: a version 1 document is read and
 * normalised, a version 2 document is read as written. Writing always produces
 * version 2.
 */
export const lockfileDocumentSchema = z.discriminatedUnion('schemaVersion', [
  lockfileDocumentV1Schema,
  lockfileDocumentV2Schema,
]);

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
/** One target's resolved source and the verified bytes that target produced. */
export type LockTargetInput = {
  source: ResolvedSource;
  files: readonly RenderedFile[];
};

function lockPersonasOf(source: ResolvedSource): LockPersona[] {
  return source.personas
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
}

/**
 * One rendered file's lockfile entry.
 *
 * A `region` entry records the digest and size of the body between the markers,
 * never of the whole file. `file.bytes` **is** that body for a region file, so
 * the fallback digest is over the right bytes; a region shape without an id is
 * an internal contradiction (the reader would refuse the document it produced),
 * so it is refused here rather than recorded as a whole file the tool does not
 * own.
 */
function lockEntryOf(file: RenderedFile): LockFileEntry {
  if (file.shape === 'region') {
    if (file.regionId === undefined) {
      throw invalidConfig(`a region file must name its region id: ${file.path}`, {
        subject: file.path,
        action: 'record the region id this path owns; a region entry is unreadable without one',
      });
    }
    return {
      path: file.path,
      regionId: file.regionId,
      sha256: file.ownedSha256 ?? sha256Hex(file.bytes),
      size: file.ownedSize ?? Buffer.byteLength(file.bytes),
      shape: 'region',
    };
  }
  // A `structured` entry must name the keys it owns; the reader refuses one
  // with an empty `ownedKeys`. A file that declares the shape but owns no key
  // (the generated document has none of them) is recorded whole instead, so
  // everything this builder produces reads back. Any other shape is carried
  // through unchanged.
  const ownedStructured =
    file.shape === 'structured' && file.ownedKeys !== undefined && file.ownedKeys.length > 0;
  const shape: LockEntryShape | undefined = ownedStructured
    ? 'structured'
    : file.shape === 'structured'
      ? undefined
      : file.shape;
  return {
    path: file.path,
    sha256: ownedStructured ? (file.ownedSha256 ?? sha256Hex(file.bytes)) : sha256Hex(file.bytes),
    size: ownedStructured
      ? (file.ownedSize ?? Buffer.byteLength(file.bytes))
      : Buffer.byteLength(file.bytes),
    ...(shape === undefined ? {} : { shape }),
    ...(ownedStructured && file.ownedKeys !== undefined ? { ownedKeys: file.ownedKeys } : {}),
  };
}

function lockFilesOf(files: readonly RenderedFile[]): LockFileEntry[] {
  return files.map(lockEntryOf).sort((a, b) => {
    const byPath = compareCodepoints(a.path, b.path);
    // Two regions of one file are two entries; the id orders them so the
    // document is deterministic whichever order the plan produced them in.
    return byPath === 0 ? compareCodepoints(a.regionId ?? '', b.regionId ?? '') : byPath;
  });
}

/**
 * Build the version 2 manifest over every target's resolved source and verified
 * files. Every value is derived, never timestamped, so two runs over one source
 * produce identical bytes. Target keys and every file list are canonically
 * ordered; `canonicalJsonFile` then sorts the object keys on serialise.
 *
 * The renderer identity is the build's pin, so the bytes are identical on two
 * machines with the same source and toolchain.
 *
 * `warnings` is the source-derived warning set only. A renderer-level warning
 * (such as `W114_RENDERER_INTEGRITY_UNVERIFIED`) is evidence about the machine
 * that ran, not about the source, so `prepareRender` keeps it out of this
 * document: writing it here made a verified and an unverified machine produce
 * different lockfile bytes for the same source, and `check` reported drift for
 * a tree whose source had not changed. The command still reports it. The
 * lockfile does not list itself.
 *
 * A `structured` file records the digest and size of its owned subset, and a
 * `region` file the digest and size of the body between its markers, never of
 * the whole file: the rest of either file is the user's, and recording it would
 * make the lockfile depend on user content.
 */
export function buildLockfile(
  renderer: LockfileRenderer,
  entries: readonly LockTargetInput[],
  warnings: readonly Warning[],
  derived: { configDigest: string },
): Lockfile {
  const targets: Record<string, LockTarget> = {};
  for (const entry of [...entries].sort((a, b) =>
    compareCodepoints(a.source.target, b.source.target),
  )) {
    targets[entry.source.target] = {
      mode: entry.source.mode,
      activePersona: entry.source.active,
      notLive: [...entry.source.notLive].sort(compareCodepoints),
      personas: lockPersonasOf(entry.source),
      files: lockFilesOf(entry.files),
    };
  }
  return {
    schemaVersion: LOCKFILE_SCHEMA_VERSION,
    readVersion: 2,
    product: { name: PRODUCT_NAME, version: PRODUCT_VERSION },
    renderer,
    configDigest: derived.configDigest,
    targets,
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
  // `readVersion` describes the document that was read, not the document this
  // build writes, so it is deliberately absent from the bytes.
  const { readVersion: _readVersion, ...document } = lock;
  return canonicalJsonFile(document);
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
  if (document.schemaVersion === 1) {
    return normaliseVersionOne(document);
  }
  return normaliseVersionTwo(document);
}

type VersionOneDocument = z.infer<typeof lockfileDocumentV1Schema>;
type VersionTwoDocument = z.infer<typeof lockfileDocumentV2Schema>;

/**
 * Normalise the mode of one target entry. A legacy lockfile has neither field:
 * it was written when every target was in agent mode, so the honest
 * normalisation is agent mode with no active persona. A document that names
 * profile mode must name the persona.
 */
function normaliseMode(
  mode: RenderMode | undefined,
  activePersona: string | null | undefined,
  subject: string,
): { mode: RenderMode; activePersona: string | null } {
  const resolved = mode ?? (activePersona != null ? MODE_PROFILE : MODE_AGENT);
  const active = resolved === MODE_PROFILE ? (activePersona ?? null) : null;
  if (resolved === MODE_PROFILE && active === null) {
    throw malformedLockfile(`records profile mode without an active persona${subject}`);
  }
  return { mode: resolved, activePersona: active };
}

/**
 * A version 1 document becomes one target entry using its `target`, and the
 * rest of the document is carried over unchanged. The existing normalisation
 * of `mode` from `activePersona`, and the profile-without-persona refusal, are
 * kept.
 */
function normaliseVersionOne(document: VersionOneDocument): Lockfile {
  const { mode, activePersona } = normaliseMode(document.mode, document.activePersona, '');
  return {
    schemaVersion: LOCKFILE_SCHEMA_VERSION,
    readVersion: 1,
    product: document.product,
    renderer: document.renderer,
    ...(document.configDigest === undefined ? {} : { configDigest: document.configDigest }),
    targets: {
      [document.target]: {
        mode,
        activePersona,
        notLive: [...(document.notLive ?? [])].sort(compareCodepoints),
        personas: document.personas,
        files: document.files,
      },
    },
    warnings: document.warnings,
  };
}

/** A version 2 document, with each entry's mode normalised the same way. */
function normaliseVersionTwo(document: VersionTwoDocument): Lockfile {
  const targets: Record<string, LockTarget> = {};
  const ids = (Object.keys(document.targets) as Array<keyof typeof document.targets>).sort(
    compareCodepoints,
  );
  for (const target of ids) {
    const entry = document.targets[target];
    if (entry === undefined) {
      continue;
    }
    const { mode, activePersona } = normaliseMode(
      entry.mode,
      entry.activePersona,
      ` for target "${target}"`,
    );
    targets[target] = {
      mode,
      activePersona,
      notLive: [...entry.notLive].sort(compareCodepoints),
      personas: entry.personas,
      files: entry.files,
    };
  }
  return {
    schemaVersion: LOCKFILE_SCHEMA_VERSION,
    readVersion: 2,
    product: document.product,
    renderer: document.renderer,
    ...(document.configDigest === undefined ? {} : { configDigest: document.configDigest }),
    targets,
    warnings: document.warnings,
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

/**
 * Every recorded entry, across every target. This flat union is what orphan
 * planning and drift detection need: a path is recorded once even when the
 * target that recorded it is no longer configured.
 */
export function lockfileFiles(lockfile: Lockfile | undefined): LockFileEntry[] {
  return Object.values(lockfile?.targets ?? {}).flatMap((target) => target.files);
}

/** The target entry that recorded a path, when one did. */
export function lockfileTargetOf(lockfile: Lockfile | undefined, path: string): string | undefined {
  for (const [target, entry] of Object.entries(lockfile?.targets ?? {})) {
    if (entry.files.some((file) => file.path === path)) {
      return target;
    }
  }
  return undefined;
}

/** The lockfile entry recorded for one managed path, when there is one. */
export function recordedEntry(
  lockfile: Lockfile | undefined,
  path: string,
): LockFileEntry | undefined {
  return lockfileFiles(lockfile).find((file) => file.path === path);
}
