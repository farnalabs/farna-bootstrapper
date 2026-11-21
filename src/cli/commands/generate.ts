import { LOCK_PATH } from '../../core/constants.js';
import { driftRefused, FarnaError } from '../../core/errors.js';
import { readLockfile } from '../../lock/lockfile.js';
import { commitFiles, type FileStatus, inspectManagedTarget } from '../../render/commit.js';
import type { RenderTarget } from '../../render/port.js';
import { prepareRender } from '../../render/prepare.js';
import type { Warning } from '../../report/warnings.js';

export type GenerateOptions = {
  cwd: string;
  dryRun: boolean;
};

export type GenerateResult = {
  ok: true;
  target: string;
  dryRun: boolean;
  personas: string[];
  files: Array<{ path: string; status: FileStatus | 'would-write' }>;
  warnings: Warning[];
};

/**
 * The paths the committed lockfile proves this tool wrote. The lockfile does
 * not list itself, so it is always owned. `undefined` means the lockfile could
 * not be read as a regular file or a symlink; the commit preflight owns that
 * diagnostic (`F003`/`F012`), so ownership checking is skipped and the guard
 * that names the real problem is not masked.
 */
async function recordedManagedPaths(cwd: string): Promise<Set<string> | undefined> {
  let lock: Awaited<ReturnType<typeof readLockfile>>;
  try {
    lock = await readLockfile(cwd);
  } catch (error) {
    if (error instanceof FarnaError) {
      return undefined;
    }
    throw error;
  }
  return new Set([LOCK_PATH, ...(lock?.files.map((file) => file.path) ?? [])]);
}

/**
 * Render the source tree, verify containment, then write the verified set.
 * In dry-run mode nothing is written, and every path is compared with the
 * working tree so the plan distinguishes `unchanged` from `would-write`.
 *
 * Before anything is written, every managed target that already exists must be
 * recorded in the committed lockfile. Without that check `generate` would take
 * over a user's `opencode.jsonc` (or any other file whose name matches a
 * managed path) merely because it happened to exist. `F007_DRIFT` is the
 * refusal: the path is not this run's output.
 */
export async function runGenerate(
  options: GenerateOptions,
  renderer: RenderTarget,
): Promise<GenerateResult> {
  const prepared = await prepareRender(options.cwd, renderer);
  const personas = prepared.source.personas.map((persona) => persona.id);
  const recorded = await recordedManagedPaths(options.cwd);

  if (options.dryRun) {
    const files: GenerateResult['files'] = [];
    for (const file of prepared.files) {
      // The same containment and type checks the write path makes: dry-run
      // must not read a plan through a symlinked or non-directory ancestor.
      // Compare bytes: decoded text can collapse an invalid byte and a genuine
      // U+FFFD to the same string, reporting "unchanged" for a file that needs
      // repair.
      const current = await inspectManagedTarget(options.cwd, file.path);
      if (recorded !== undefined && current.existing !== undefined && !recorded.has(file.path)) {
        throw driftRefused(
          `refusing to overwrite ${file.path}: it exists but is not recorded in the committed lockfile`,
          {
            subject: file.path,
            action: 'move the existing file aside, or remove it deliberately, then re-run generate',
          },
        );
      }
      const matches = current.existing?.equals(Buffer.from(file.bytes, 'utf8')) === true;
      files.push({
        path: file.path,
        status: matches ? 'unchanged' : 'would-write',
      });
    }
    return {
      ok: true,
      target: prepared.source.target,
      dryRun: true,
      personas,
      files,
      warnings: prepared.warnings,
    };
  }

  if (recorded !== undefined) {
    for (const file of prepared.files) {
      const current = await inspectManagedTarget(options.cwd, file.path);
      if (current.existing !== undefined && !recorded.has(file.path)) {
        throw driftRefused(
          `refusing to overwrite ${file.path}: it exists but is not recorded in the committed lockfile`,
          {
            subject: file.path,
            action: 'move the existing file aside, or remove it deliberately, then re-run generate',
          },
        );
      }
    }
  }

  const committed = await commitFiles(options.cwd, prepared.files);
  return {
    ok: true,
    target: prepared.source.target,
    dryRun: false,
    personas,
    files: committed.statuses,
    warnings: prepared.warnings,
  };
}
