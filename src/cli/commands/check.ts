import { join } from 'node:path';
import {
  DRIFT_CODE,
  EXIT,
  LOCK_PATH,
  MANAGED_FILE_MAX_BYTES,
  type RenderMode,
  ROOT_DIR,
} from '../../core/constants.js';
import { readBoundedBytes } from '../../core/fs.js';
import { compareCodepoints } from '../../core/json.js';
import { assertRealDirectory, containedTarget, lstatOrUndefined } from '../../core/paths.js';
import { readLockfile } from '../../lock/lockfile.js';
import { verifyRendererIdentity } from '../../render/identity.js';
import type { RenderTarget } from '../../render/port.js';
import { prepareRender } from '../../render/prepare.js';
import type { Warning } from '../../report/warnings.js';

export type DriftKind = 'missing' | 'modified' | 'unexpected';

export type DriftItem = {
  code: typeof DRIFT_CODE;
  path: string;
  kind: DriftKind;
  detail: string;
};

export type CheckOptions = {
  /** The `--persona` override. It selects profile mode and wins over the config. */
  persona?: string;
};

export type CheckResult = {
  ok: boolean;
  target: string;
  mode: RenderMode;
  activePersona: string | null;
  exitCode: 0 | typeof EXIT.drift;
  checked: string[];
  drift: DriftItem[];
  warnings: Warning[];
};

/**
 * Regenerate into a disposable stage and compare the result with the working
 * tree. Never writes. Exit 0 when identical, 1 when anything drifted.
 *
 * Drift is scoped to what this tool owns: every path in the fresh plan (a
 * missing or changed managed file) and every path the committed lockfile
 * records (an output the source no longer produces). An unrecorded file in a
 * managed directory or the repository root belongs to the user and is never
 * reported: a repository may legitimately keep its own `opencode.jsonc` or its
 * own `.opencode/commands/custom.md`, and `check` must not call its own
 * repository dirty for files it did not write.
 *
 * The source root is validated before the lockfile is read, so a broken source
 * tree is reported as itself rather than after a lockfile read. The renderer
 * identity recorded in the lockfile is checked next: a renderer that is not the
 * one that produced the committed bytes fails F010 (exit 5) before any byte
 * comparison, so drift is never blamed on the wrong cause.
 */
export async function runCheck(
  repoRoot: string,
  renderer: RenderTarget,
  options: CheckOptions = {},
): Promise<CheckResult> {
  await assertRealDirectory(join(repoRoot, ROOT_DIR), ROOT_DIR);

  const lockfile = await readLockfile(repoRoot);
  if (lockfile !== undefined) {
    verifyRendererIdentity(lockfile.renderer, renderer.identity(), LOCK_PATH);
  }

  const prepared = await prepareRender(repoRoot, renderer, {
    ...(options.persona === undefined ? {} : { persona: options.persona }),
  });
  const drift: DriftItem[] = [];

  for (const file of prepared.files) {
    const absolute = await containedTarget(repoRoot, file.path);
    const stats = await lstatOrUndefined(absolute, file.path);
    if (stats === undefined) {
      drift.push({
        code: DRIFT_CODE,
        path: file.path,
        kind: 'missing',
        detail: 'managed file is missing',
      });
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      drift.push({
        code: DRIFT_CODE,
        path: file.path,
        kind: 'modified',
        detail: 'managed path is not a regular file',
      });
      continue;
    }
    const existing = await readBoundedBytes(absolute, file.path, {
      action: 'make the managed file readable and re-run check',
      maxBytes: MANAGED_FILE_MAX_BYTES,
    });
    if (!existing.equals(Buffer.from(file.bytes, 'utf8'))) {
      drift.push({
        code: DRIFT_CODE,
        path: file.path,
        kind: 'modified',
        detail: 'content differs from a fresh render',
      });
    }
  }

  const expected = new Set(prepared.files.map((file) => file.path));
  // A recorded path the current source no longer produces is drift whether or
  // not it is still on disk: removing the last declaration must not leave a
  // live config that `check` calls clean. Only the lockfile can name it; the
  // on-disk scan is deliberately gone, because an unrecorded path is not ours.
  const recorded = new Set(lockfile?.files.map((file) => file.path) ?? []);
  for (const path of recorded) {
    if (expected.has(path)) {
      continue;
    }
    drift.push({
      code: DRIFT_CODE,
      path,
      kind: 'unexpected',
      detail: 'path is recorded in the lockfile but no longer produced by this source',
    });
  }

  drift.sort((a, b) => compareCodepoints(a.path, b.path));
  return {
    ok: drift.length === 0,
    target: prepared.source.target,
    mode: prepared.source.mode,
    activePersona: prepared.source.active,
    exitCode: drift.length === 0 ? EXIT.ok : EXIT.drift,
    checked: prepared.files.map((file) => file.path),
    drift,
    warnings: prepared.warnings,
  };
}
