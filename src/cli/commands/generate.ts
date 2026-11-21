import { LOCK_PATH, type RenderMode } from '../../core/constants.js';
import { driftRefused, FarnaError } from '../../core/errors.js';
import { decodeUtf8 } from '../../core/fs.js';
import { compareCodepoints } from '../../core/json.js';
import { type LockFileEntry, type Lockfile, readLockfile } from '../../lock/lockfile.js';
import {
  type CommitOperations,
  commitFiles,
  type FileStatus,
  inspectManagedTarget,
  type ManagedTarget,
} from '../../render/commit.js';
import { withGenerateLock } from '../../render/generate-lock.js';
import { planOrphans, removeOrphans } from '../../render/orphans.js';
import type { RenderTarget } from '../../render/port.js';
import { type PreparedRender, prepareRender } from '../../render/prepare.js';
import { mergeStructuredText, structuredOwnedKeys } from '../../render/structured.js';
import type { Warning } from '../../report/warnings.js';

export type GenerateOptions = {
  cwd: string;
  dryRun: boolean;
  /** The `--persona` override. It selects profile mode and wins over the config. */
  persona?: string;
  /**
   * Take ownership of every existing planned managed output. Required when the
   * lockfile is absent and a planned output exists: without it the tool cannot
   * tell its own render from a file the user wrote.
   */
  adopt?: boolean;
  /**
   * The filesystem seam the commit uses. Production never sets it; a failure
   * test injects a rename or write failure to prove the recovery path.
   */
  commitOperations?: Partial<CommitOperations>;
};

export type OrphanStatus = 'removed' | 'would-remove' | 'updated' | 'would-update' | 'missing';

export type GenerateResult = {
  ok: true;
  target: string;
  mode: RenderMode;
  activePersona: string | null;
  /** Personas resolved but not live. Empty in agent mode. */
  notLive: string[];
  dryRun: boolean;
  /** Paths taken over by `--adopt` (or, in a dry run, that would be). */
  adopted: string[];
  personas: string[];
  files: Array<{ path: string; status: FileStatus | 'would-write' }>;
  /**
   * Recorded paths this run no longer produces. A whole file is removed; a
   * structured file that still carries user keys is updated in place (its
   * owned key deleted) and the record dropped.
   */
  removed: Array<{ path: string; status: OrphanStatus }>;
  warnings: Warning[];
};

/**
 * What the committed lockfile proves this tool wrote. `paths` includes the
 * lockfile itself, which is always owned and never records itself; `entries`
 * excludes it. A present but unreadable lockfile is a typed error from
 * `readLockfile`, never an empty record set: treating it as absent skipped
 * orphan removal and rewrote a lockfile that had forgotten every earlier path.
 */
type RecordedState = {
  lockfile: Lockfile | undefined;
  paths: Set<string>;
  entries: readonly LockFileEntry[];
};

async function recordedState(cwd: string): Promise<RecordedState> {
  const lockfile = await readLockfile(cwd);
  return {
    lockfile,
    paths: new Set([LOCK_PATH, ...(lockfile?.files.map((file) => file.path) ?? [])]),
    entries: lockfile?.files ?? [],
  };
}

/** The planned managed outputs that already exist on disk. */
function existingOutputs(
  files: PreparedRender['files'],
  inspected: Map<string, ManagedTarget>,
): string[] {
  return files
    .filter((file) => file.path !== LOCK_PATH)
    .filter((file) => inspected.get(file.path)?.existing !== undefined)
    .map((file) => file.path)
    .sort(compareCodepoints);
}

/**
 * A missing lockfile with outputs already on disk is not proof of ownership.
 * The tool cannot tell its own earlier render from a file the user wrote, so it
 * refuses and asks for an explicit `--adopt` rather than guessing from names.
 */
function lockfileMissing(existing: readonly string[]): FarnaError {
  return driftRefused(
    `refusing to continue: ${LOCK_PATH} is missing but ${existing.length} managed output(s) from this plan already exist (${existing.join(', ')})`,
    {
      ...(existing[0] === undefined ? {} : { subject: existing[0] }),
      action:
        'run generate --adopt to take ownership of every existing managed output; a file not in the plan is never adopted or removed',
    },
  );
}

/** Resolve every planned target to its current bytes, or `undefined` when absent. */
async function inspectPlan(
  cwd: string,
  files: PreparedRender['files'],
): Promise<Map<string, ManagedTarget>> {
  const inspected = new Map<string, ManagedTarget>();
  for (const file of files) {
    inspected.set(file.path, await inspectManagedTarget(cwd, file.path));
  }
  return inspected;
}

/**
 * Refuse an unrecorded path this tool cannot prove it owns, unless its bytes are
 * exactly what this run would write or the caller explicitly adopted it.
 *
 * An unrecorded path is adoptable when it already holds the fresh render: that
 * is the recovery path after a deleted lockfile, where the outputs are this
 * tool's own and only the record was lost. An unrecorded path that differs is
 * refused (F007) unless `--adopt` was passed, because taking it over would
 * destroy bytes this tool did not write.
 */
function assertOwnership(
  files: PreparedRender['files'],
  inspected: Map<string, ManagedTarget>,
  recorded: Set<string>,
  adopt: boolean,
): void {
  if (adopt) {
    return;
  }
  for (const file of files) {
    const current = inspected.get(file.path)?.existing;
    if (current === undefined || recorded.has(file.path)) {
      continue;
    }
    if (!current.equals(Buffer.from(file.bytes, 'utf8'))) {
      throw driftRefused(
        `refusing to overwrite ${file.path}: it exists but is not recorded in the committed lockfile and its bytes differ from a fresh render`,
        {
          subject: file.path,
          action:
            'run generate --adopt to take ownership of the existing managed output, or move it aside deliberately',
        },
      );
    }
  }
}

/**
 * The bytes this run will write for a structured file: the owned keys merged
 * into the user's document **in place**, preserving every other byte including
 * comments and whitespace.
 *
 * The merge applies to a path in the committed lockfile and, with `--adopt`, to
 * an existing planned file the lockfile does not record. Any other file is
 * either absent (the fresh render is written) or was refused by
 * `assertOwnership`.
 */
function mergeStructuredFiles(
  files: PreparedRender['files'],
  inspected: Map<string, ManagedTarget>,
  recorded: Set<string>,
  adopt: boolean,
): Array<{ path: string; bytes: string }> {
  return files.map((file) => {
    const ownedKeys = structuredOwnedKeys(file.path);
    const existing = inspected.get(file.path)?.existing;
    const owned = recorded.has(file.path) || adopt;
    if (ownedKeys === undefined || existing === undefined || !owned) {
      return { path: file.path, bytes: file.bytes };
    }
    return {
      path: file.path,
      bytes: mergeStructuredText(decodeUtf8(existing, file.path), file.bytes, ownedKeys, file.path),
    };
  });
}

/**
 * Re-throw a commit failure with the removals this run already made named. The
 * commit's own message ("nothing was written") is true of the commit and false
 * of the run: the orphan removal happened first, so the tree is partially
 * updated and the reader must be told which paths are gone.
 */
function commitFailure(
  error: unknown,
  removed: readonly { path: string; status: 'removed' | 'updated' | 'missing' }[],
): unknown {
  const paths = removed.filter((entry) => entry.status === 'removed').map((entry) => entry.path);
  const updated = removed.filter((entry) => entry.status === 'updated').map((entry) => entry.path);
  if (!(error instanceof FarnaError) || (paths.length === 0 && updated.length === 0)) {
    return error;
  }
  const details: string[] = [];
  if (paths.length > 0) {
    details.push(`this run already removed ${paths.length} recorded path(s) (${paths.join(', ')})`);
  }
  if (updated.length > 0) {
    details.push(
      `this run already updated ${updated.length} recorded path(s) (${updated.join(', ')})`,
    );
  }
  return new FarnaError(
    error.code,
    `${error.message}; ${details.join('; ')} before the write failed, so the tree is partially updated`,
    {
      ...(error.subject === undefined ? {} : { subject: error.subject }),
      action:
        're-run generate after fixing the filesystem; the lockfile still records the affected paths',
      cause: error,
    },
  );
}

/**
 * Render the source tree, verify containment, then write the verified set.
 * In dry-run mode nothing is written, and every path is compared with the
 * working tree so the plan distinguishes `unchanged` from `would-write`.
 *
 * The whole read → plan → remove → commit sequence runs under an exclusive
 * `.farna/.generate.lock` directory, so two concurrent runs cannot each plan
 * from the same lockfile and delete each other's output.
 *
 * Ownership is explicit, never inferred from a file name. When the lockfile is
 * absent and a planned output already exists, this refuses (`F007`) and names
 * `generate --adopt`; `check` refuses the same tree and never adopts. With
 * `--adopt` every existing planned managed output is taken over: `opencode.jsonc`
 * keeps the user's other keys (only the owned `mcp` key is merged), every other
 * planned file is overwritten with the fresh render, and the lockfile records
 * the result. A file not in the plan is neither adopted nor removed.
 *
 * A recorded path the new plan no longer produces is an orphan (a persona
 * switch, a removed resource). It is preflighted with the same rigour and
 * removed before the new set is committed. Removing before the commit means a
 * failed commit leaves the tree visibly missing the old artefacts, which
 * `check` reports; writing first would leave an unrecorded orphan behind, which
 * nothing could ever find again. Only a recorded regular file in a managed
 * location whose bytes still match its recorded digest is removed; a symlink,
 * a directory, an edited file or an unrecorded user file is never touched.
 */
export async function runGenerate(
  options: GenerateOptions,
  renderer: RenderTarget,
): Promise<GenerateResult> {
  const adopt = options.adopt === true;
  return await withGenerateLock(options.cwd, async () => {
    const prepared = await prepareRender(options.cwd, renderer, {
      ...(options.persona === undefined ? {} : { persona: options.persona }),
    });
    const personas = prepared.source.personas.map((persona) => persona.id);
    const recorded = await recordedState(options.cwd);
    const inspected = await inspectPlan(options.cwd, prepared.files);
    const existing = existingOutputs(prepared.files, inspected);
    if (recorded.lockfile === undefined && existing.length > 0 && !adopt) {
      throw lockfileMissing(existing);
    }
    assertOwnership(prepared.files, inspected, recorded.paths, adopt);
    const adopted = existing.filter((path) => !recorded.paths.has(path));
    const expected = new Set(prepared.files.map((file) => file.path));
    const orphans = await planOrphans(options.cwd, recorded.entries, expected);
    const planned = mergeStructuredFiles(prepared.files, inspected, recorded.paths, adopt);

    if (options.dryRun) {
      const files: GenerateResult['files'] = [];
      for (const file of planned) {
        // Compare bytes: decoded text can collapse an invalid byte and a genuine
        // U+FFFD to the same string, reporting "unchanged" for a file that needs
        // repair.
        const current = inspected.get(file.path)?.existing;
        const matches = current?.equals(Buffer.from(file.bytes, 'utf8')) === true;
        files.push({
          path: file.path,
          status: matches ? 'unchanged' : 'would-write',
        });
      }
      return {
        ok: true,
        target: prepared.source.target,
        mode: prepared.source.mode,
        activePersona: prepared.source.active,
        notLive: prepared.source.notLive,
        dryRun: true,
        adopted,
        personas,
        files,
        removed: orphans.map((orphan) => ({
          path: orphan.entry.path,
          status:
            orphan.action === 'remove' ? ('would-remove' as const) : ('would-update' as const),
        })),
        warnings: prepared.warnings,
      };
    }

    const removed = await removeOrphans(options.cwd, orphans);
    let committed: Awaited<ReturnType<typeof commitFiles>>;
    try {
      committed = await commitFiles(options.cwd, planned, options.commitOperations ?? {});
    } catch (error) {
      throw commitFailure(error, removed);
    }
    return {
      ok: true,
      target: prepared.source.target,
      mode: prepared.source.mode,
      activePersona: prepared.source.active,
      notLive: prepared.source.notLive,
      dryRun: false,
      adopted,
      personas,
      files: committed.statuses,
      removed: removed.sort((a, b) => compareCodepoints(a.path, b.path)),
      warnings: prepared.warnings,
    };
  });
}
