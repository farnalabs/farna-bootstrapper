import { LOCK_PATH, type RenderMode } from '../../core/constants.js';
import { driftRefused, FarnaError } from '../../core/errors.js';
import { type LockFileEntry, readLockfile } from '../../lock/lockfile.js';
import {
  commitFiles,
  type FileStatus,
  inspectManagedTarget,
  type ManagedTarget,
} from '../../render/commit.js';
import { planOrphans, removeOrphans } from '../../render/orphans.js';
import type { RenderTarget } from '../../render/port.js';
import { type PreparedRender, prepareRender } from '../../render/prepare.js';
import type { Warning } from '../../report/warnings.js';

export type GenerateOptions = {
  cwd: string;
  dryRun: boolean;
  /** The `--persona` override. It selects profile mode and wins over the config. */
  persona?: string;
};

export type OrphanStatus = 'removed' | 'would-remove';

export type GenerateResult = {
  ok: true;
  target: string;
  mode: RenderMode;
  activePersona: string | null;
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
 * excludes it. `paths === undefined` means the lockfile could not be read as a
 * regular file or a symlink; the commit preflight owns that diagnostic
 * (`F003`/`F012`), so ownership checking is skipped and the guard that names the
 * real problem is not masked.
 */
type RecordedState = {
  paths: Set<string> | undefined;
  entries: readonly LockFileEntry[];
};

async function recordedState(cwd: string): Promise<RecordedState> {
  let lock: Awaited<ReturnType<typeof readLockfile>>;
  try {
    lock = await readLockfile(cwd);
  } catch (error) {
    if (error instanceof FarnaError) {
      return { paths: undefined, entries: [] };
    }
    throw error;
  }
  return {
    paths: new Set([LOCK_PATH, ...(lock?.files.map((file) => file.path) ?? [])]),
    entries: lock?.files ?? [],
  };
}

/**
 * Read every prepared target and refuse an existing path this tool cannot
 * prove it owns, unless its bytes are exactly what this run would write.
 *
 * An unrecorded path is adoptable when it already holds the fresh render: that
 * is the recovery path after a deleted lockfile, where the outputs are this
 * tool's own and only the record was lost. Rewriting the lockfile records them
 * again. An unrecorded path that differs is refused (F007), because taking it
 * over would destroy bytes this tool did not write.
 *
 * `recorded === undefined` means the lockfile itself could not be read; the
 * commit preflight owns that diagnostic, so ownership checking is skipped.
 */
async function inspectPlan(
  cwd: string,
  files: PreparedRender['files'],
  recorded: Set<string> | undefined,
): Promise<Map<string, ManagedTarget>> {
  const inspected = new Map<string, ManagedTarget>();
  for (const file of files) {
    const current = await inspectManagedTarget(cwd, file.path);
    if (recorded !== undefined && current.existing !== undefined && !recorded.has(file.path)) {
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
 * Render the source tree, verify containment, then write the verified set.
 * In dry-run mode nothing is written, and every path is compared with the
 * working tree so the plan distinguishes `unchanged` from `would-write`.
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
  const prepared = await prepareRender(options.cwd, renderer, {
    ...(options.persona === undefined ? {} : { persona: options.persona }),
  });
  const personas = prepared.source.personas.map((persona) => persona.id);
  const recorded = await recordedState(options.cwd);
  const inspected = await inspectPlan(options.cwd, prepared.files, recorded.paths);
  const expected = new Set(prepared.files.map((file) => file.path));
  const orphans = await planOrphans(options.cwd, recorded.entries, expected);

  if (options.dryRun) {
    const files: GenerateResult['files'] = [];
    for (const file of prepared.files) {
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
      dryRun: true,
      personas,
      files,
      removed: orphans.map((path) => ({ path, status: 'would-remove' as const })),
      warnings: prepared.warnings,
    };
  }

  await removeOrphans(options.cwd, orphans);
  const committed = await commitFiles(options.cwd, prepared.files);
  return {
    ok: true,
    target: prepared.source.target,
    mode: prepared.source.mode,
    activePersona: prepared.source.active,
    dryRun: false,
    personas,
    files: committed.statuses,
    removed: orphans.map((path) => ({ path, status: 'removed' as const })),
    warnings: prepared.warnings,
  };
}
