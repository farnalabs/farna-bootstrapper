import { LOCK_PATH, MODE_PROFILE, type RenderMode } from '../../core/constants.js';
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
import { findStaleRenders } from '../../render/root-cleanliness.js';
import {
  mergeStructured,
  parseStructuredDocument,
  serialiseStructured,
  structuredOwnedKeys,
} from '../../render/structured.js';
import type { Warning } from '../../report/warnings.js';

export type GenerateOptions = {
  cwd: string;
  dryRun: boolean;
  /** The `--persona` override. It selects profile mode and wins over the config. */
  persona?: string;
  /**
   * The filesystem seam the commit uses. Production never sets it; a failure
   * test injects a rename or write failure to prove the recovery path.
   */
  commitOperations?: Partial<CommitOperations>;
};

export type OrphanStatus = 'removed' | 'would-remove' | 'missing';

export type GenerateResult = {
  ok: true;
  target: string;
  mode: RenderMode;
  activePersona: string | null;
  /** Personas resolved but not live. Empty in agent mode. */
  notLive: string[];
  dryRun: boolean;
  personas: string[];
  files: Array<{ path: string; status: FileStatus | 'would-write' }>;
  /** Recorded paths this run no longer produces, removed (or planned on a dry run). */
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

/**
 * Refuse an existing path this tool cannot prove it owns, unless its bytes are
 * exactly what this run would write.
 *
 * An unrecorded path is adoptable when it already holds the fresh render: that
 * is the recovery path after a deleted lockfile, where the outputs are this
 * tool's own and only the record was lost. Rewriting the lockfile records them
 * again. An unrecorded path that differs is refused (F007), because taking it
 * over would destroy bytes this tool did not write.
 */
async function inspectPlan(
  cwd: string,
  files: PreparedRender['files'],
  recorded: Set<string>,
): Promise<Map<string, ManagedTarget>> {
  const inspected = new Map<string, ManagedTarget>();
  for (const file of files) {
    const current = await inspectManagedTarget(cwd, file.path);
    if (current.existing !== undefined && !recorded.has(file.path)) {
      if (!current.existing.equals(Buffer.from(file.bytes, 'utf8'))) {
        throw driftRefused(
          `refusing to overwrite ${file.path}: it exists but is not recorded in the committed lockfile and its bytes differ from a fresh render`,
          {
            subject: file.path,
            action:
              'move the managed outputs aside, or remove them deliberately, then re-run generate',
          },
        );
      }
    }
    inspected.set(file.path, current);
  }
  return inspected;
}

/**
 * The bytes this run will write for a structured file: the generated document
 * merged into the user's, preserving every key this tool does not own.
 *
 * The merge is only for a file the lockfile records. An unrecorded file that
 * already exists was checked by `inspectPlan` and is either byte-identical (the
 * recovery path) or refused, so this function never takes one over.
 */
function mergeStructuredFiles(
  files: PreparedRender['files'],
  inspected: Map<string, ManagedTarget>,
  recorded: Set<string>,
): Array<{ path: string; bytes: string }> {
  return files.map((file) => {
    const ownedKeys = structuredOwnedKeys(file.path);
    const existing = inspected.get(file.path)?.existing;
    if (ownedKeys === undefined || existing === undefined || !recorded.has(file.path)) {
      return { path: file.path, bytes: file.bytes };
    }
    const existingDocument = parseStructuredDocument(decodeUtf8(existing, file.path), file.path);
    const generatedDocument = parseStructuredDocument(file.bytes, file.path);
    return {
      path: file.path,
      bytes: serialiseStructured(mergeStructured(existingDocument, generatedDocument, ownedKeys)),
    };
  });
}

/**
 * In profile mode, a file a declared persona or resource could have produced,
 * that is neither in the plan nor recorded, is a plausible prior render: a
 * persona switched while the lockfile was lost, or output from an older
 * version. `generate` refuses rather than overwriting or ignoring it.
 */
async function assertNoStaleRenders(
  cwd: string,
  prepared: PreparedRender,
  recorded: Set<string>,
): Promise<void> {
  if (prepared.source.mode !== MODE_PROFILE) {
    return;
  }
  const planned = new Set(prepared.files.map((file) => file.path));
  const stale = await findStaleRenders(cwd, prepared.declaredPaths, planned, recorded);
  if (stale.length === 0) {
    return;
  }
  const names = stale.map((entry) => entry.path).join(', ');
  throw driftRefused(
    `refusing to generate: ${stale.length} path(s) look like an earlier render but the lockfile does not record them: ${names}`,
    {
      ...(stale[0] === undefined ? {} : { subject: stale[0].path }),
      action:
        'remove those paths deliberately, then re-run generate; the lockfile records what this tool wrote',
    },
  );
}

/**
 * Re-throw a commit failure with the removals this run already made named. The
 * commit's own message ("nothing was written") is true of the commit and false
 * of the run: the orphan removal happened first, so the tree is partially
 * updated and the reader must be told which paths are gone.
 */
function commitFailure(error: unknown, removed: readonly string[]): unknown {
  if (!(error instanceof FarnaError) || removed.length === 0) {
    return error;
  }
  return new FarnaError(
    error.code,
    `${error.message}; this run already removed ${removed.length} recorded path(s) (${removed.join(', ')}) before the write failed, so the tree is partially updated`,
    {
      ...(error.subject === undefined ? {} : { subject: error.subject }),
      action:
        're-run generate after fixing the filesystem; the lockfile still records the removed paths',
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
 * `.farna/.generate.lock`, so two concurrent runs cannot each plan from the same
 * lockfile and delete each other's output.
 *
 * Before anything is written, every managed target that already exists must be
 * either recorded in the committed lockfile or byte-identical to the fresh
 * render. Without that check `generate` would take over a user's
 * `opencode.jsonc` (or any other file whose name matches a managed path) merely
 * because it happened to exist. `F007_DRIFT` is the refusal: the path is not
 * this run's output and rewriting it would lose content.
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
  return await withGenerateLock(options.cwd, async () => {
    const prepared = await prepareRender(options.cwd, renderer, {
      ...(options.persona === undefined ? {} : { persona: options.persona }),
    });
    const personas = prepared.source.personas.map((persona) => persona.id);
    const recorded = await recordedState(options.cwd);
    // The stale-render refusal runs first: it names the earlier persona's
    // artefacts, which is the actionable answer when the lockfile is lost.
    await assertNoStaleRenders(options.cwd, prepared, recorded.paths);
    const inspected = await inspectPlan(options.cwd, prepared.files, recorded.paths);
    const expected = new Set(prepared.files.map((file) => file.path));
    const orphans = await planOrphans(options.cwd, recorded.entries, expected);
    const planned = mergeStructuredFiles(prepared.files, inspected, recorded.paths);

    if (options.dryRun) {
      const files: GenerateResult['files'] = [];
      for (const file of planned) {
        // Compare bytes: decoded text can collapse an invalid byte and a genuine
        // U+FFFD to the same string, reporting "unchanged" for a file that needs
        // repair.
        const existing = inspected.get(file.path)?.existing;
        const matches = existing?.equals(Buffer.from(file.bytes, 'utf8')) === true;
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
        personas,
        files,
        removed: orphans.map((entry) => ({
          path: entry.path,
          status: 'would-remove' as const,
        })),
        warnings: prepared.warnings,
      };
    }

    const removed = await removeOrphans(options.cwd, orphans);
    let committed: Awaited<ReturnType<typeof commitFiles>>;
    try {
      committed = await commitFiles(options.cwd, planned, options.commitOperations ?? {});
    } catch (error) {
      throw commitFailure(
        error,
        removed.filter((entry) => entry.status === 'removed').map((entry) => entry.path),
      );
    }
    return {
      ok: true,
      target: prepared.source.target,
      mode: prepared.source.mode,
      activePersona: prepared.source.active,
      notLive: prepared.source.notLive,
      dryRun: false,
      personas,
      files: committed.statuses,
      removed: removed.sort((a, b) => compareCodepoints(a.path, b.path)),
      warnings: prepared.warnings,
    };
  });
}
