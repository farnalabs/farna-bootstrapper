import { join } from 'node:path';
import {
  DRIFT_CODE,
  EXIT,
  LOCK_PATH,
  MANAGED_FILE_MAX_BYTES,
  MODE_PROFILE,
  OUTSIDE_OWNERSHIP_CODE,
  type RenderMode,
  ROOT_DIR,
} from '../../core/constants.js';
import { FarnaError } from '../../core/errors.js';
import { decodeUtf8, readBoundedBytes } from '../../core/fs.js';
import { compareCodepoints } from '../../core/json.js';
import { assertRealDirectory, containedTarget, lstatOrUndefined } from '../../core/paths.js';
import { readLockfile } from '../../lock/lockfile.js';
import { verifyRendererIdentity } from '../../render/identity.js';
import type { RenderTarget } from '../../render/port.js';
import { prepareRender } from '../../render/prepare.js';
import { findSkillTreeExtras } from '../../render/root-cleanliness.js';
import {
  canonicalOwnedSubset,
  parseStructuredDocument,
  structuredOwnedKeys,
} from '../../render/structured.js';
import type { Warning } from '../../report/warnings.js';

export type DriftKind = 'missing' | 'modified' | 'unexpected';

export type DriftItem = {
  /** `F007_DRIFT` for our own byte, `W107_OUTSIDE_OWNERSHIP` for something we do not own. */
  code: typeof DRIFT_CODE | typeof OUTSIDE_OWNERSHIP_CODE;
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
  /** Personas resolved but not live. Empty in agent mode. */
  notLive: string[];
  exitCode: 0 | typeof EXIT.drift;
  checked: string[];
  drift: DriftItem[];
  warnings: Warning[];
};

/** The detail `check` prints for a whole file whose bytes changed. */
const MODIFIED_DETAIL = 'content differs from a fresh render';
const MISSING_DETAIL = 'managed file is missing';
const NOT_A_FILE_DETAIL = 'managed path is not a regular file';

/**
 * Regenerate into a disposable stage and compare the result with the working
 * tree. Never writes. Exit 0 when identical, 1 when anything drifted.
 *
 * Ownership is explicit, never inferred from a file name. When `.farna/lock.json`
 * is absent and a planned managed output already exists, there is no record of
 * what this tool wrote, so `check` refuses with the same `F007` and the action
 * `run generate --adopt`. `check` never adopts.
 *
 * Drift is scoped to what this tool owns: every path in the fresh plan (a
 * missing or changed managed file) and every path the committed lockfile
 * records (an output the source no longer produces). An unrecorded file in a
 * managed directory or at the repository root belongs to the user and is not
 * reported, so a repository may legitimately keep its own `opencode.jsonc` or
 * its own `.opencode/commands/custom.md`.
 *
 * A `structured` file (`opencode.jsonc`) is compared by its owned keys only: a
 * user's `theme`, `$schema` or comment is theirs, so editing it is not drift;
 * editing the `mcp` value this tool wrote is.
 *
 * The one unrecorded path `check` does report is an extra file inside a skill
 * directory this tool owns (recorded or planned), as `W107_OUTSIDE_OWNERSHIP`.
 * It is reported and never deleted.
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
  if (lockfile === undefined) {
    // With no record, an existing planned output could be this tool's earlier
    // render or the user's file. `check` cannot tell, so it refuses and asks for
    // the explicit adoption `generate --adopt` performs.
    const existing: string[] = [];
    for (const file of prepared.files) {
      if (file.path === LOCK_PATH) {
        continue;
      }
      const absolute = await containedTarget(repoRoot, file.path);
      if ((await lstatOrUndefined(absolute, file.path)) !== undefined) {
        existing.push(file.path);
      }
    }
    if (existing.length > 0) {
      existing.sort(compareCodepoints);
      throw new FarnaError(
        DRIFT_CODE,
        `refusing to check: ${LOCK_PATH} is missing but ${existing.length} managed output(s) from this plan already exist (${existing.join(', ')})`,
        {
          ...(existing[0] === undefined ? {} : { subject: existing[0] }),
          action:
            'run generate --adopt to take ownership of every existing managed output; check never adopts',
        },
      );
    }
  }
  const drift: DriftItem[] = [];

  // A source change that renders no different byte — an edit to a persona that
  // is not live, a rule only that persona declares — is still a change to the
  // committed record. Comparing the digest is what makes it visible.
  const digestChanged =
    lockfile?.configDigest !== undefined && lockfile.configDigest !== prepared.configDigest;

  for (const file of prepared.files) {
    if (file.path === LOCK_PATH && digestChanged) {
      // Reported below as the source-digest item, which names the cause.
      continue;
    }
    const absolute = await containedTarget(repoRoot, file.path);
    const stats = await lstatOrUndefined(absolute, file.path);
    if (stats === undefined) {
      drift.push({ code: DRIFT_CODE, path: file.path, kind: 'missing', detail: MISSING_DETAIL });
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      drift.push({
        code: DRIFT_CODE,
        path: file.path,
        kind: 'modified',
        detail: NOT_A_FILE_DETAIL,
      });
      continue;
    }

    const ownedKeys = structuredOwnedKeys(file.path);
    if (ownedKeys !== undefined) {
      const existing = await readBoundedBytes(absolute, file.path, {
        action: 'make the managed file readable and re-run check',
        maxBytes: MANAGED_FILE_MAX_BYTES,
      });
      let existingOwned: string;
      try {
        existingOwned = canonicalOwnedSubset(
          parseStructuredDocument(decodeUtf8(existing, file.path), file.path),
          ownedKeys,
        );
      } catch (error) {
        if (!(error instanceof FarnaError)) {
          throw error;
        }
        drift.push({
          code: DRIFT_CODE,
          path: file.path,
          kind: 'modified',
          detail: 'structured file no longer parses as a JSON object',
        });
        continue;
      }
      const generated = parseStructuredDocument(file.bytes, file.path);
      if (existingOwned !== canonicalOwnedSubset(generated, ownedKeys)) {
        drift.push({
          code: DRIFT_CODE,
          path: file.path,
          kind: 'modified',
          detail: `owned key(s) ${ownedKeys.join(', ')} differ from a fresh render`,
        });
      }
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
        detail: MODIFIED_DETAIL,
      });
    }
  }

  if (digestChanged) {
    drift.push({
      code: DRIFT_CODE,
      path: LOCK_PATH,
      kind: 'modified',
      detail: 'the source or config changed since the lockfile was written; re-run generate',
    });
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

  if (prepared.source.mode === MODE_PROFILE) {
    const recordedEntries = lockfile?.files ?? [];
    for (const extra of await findSkillTreeExtras(repoRoot, expected, recordedEntries)) {
      drift.push({
        code: OUTSIDE_OWNERSHIP_CODE,
        path: extra.path,
        kind: 'unexpected',
        detail: extra.symbolicLink
          ? 'an unrecorded symbolic link is inside a managed skill directory'
          : 'an unrecorded file is inside a managed skill directory',
      });
    }
  }

  drift.sort((a, b) => compareCodepoints(a.path, b.path));
  return {
    ok: drift.length === 0,
    target: prepared.source.target,
    mode: prepared.source.mode,
    activePersona: prepared.source.active,
    notLive: prepared.source.notLive,
    exitCode: drift.length === 0 ? EXIT.ok : EXIT.drift,
    checked: prepared.files.map((file) => file.path),
    drift,
    warnings: prepared.warnings,
  };
}
