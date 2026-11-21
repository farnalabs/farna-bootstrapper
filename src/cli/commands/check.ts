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
import { findSkillTreeExtras, findStaleRenders } from '../../render/root-cleanliness.js';
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
 * Drift is scoped to what this tool owns: every path in the fresh plan (a
 * missing or changed managed file) and every path the committed lockfile
 * records (an output the source no longer produces). An unrecorded file in a
 * managed directory or at the repository root belongs to the user and is never
 * reported *unless it is a plausible prior render* (see below), so a repository
 * may legitimately keep its own `opencode.jsonc` or its own
 * `.opencode/commands/custom.md`.
 *
 * A `structured` file (`opencode.jsonc`) is compared by its owned keys only: a
 * user's `theme` or `$schema` is theirs, so editing it is not drift; editing the
 * `mcp` value this tool wrote is.
 *
 * Root cleanliness (profile mode): a path a declared persona or resource could
 * have produced, that is neither planned nor recorded, is a plausible prior
 * render and is reported as `W107_OUTSIDE_OWNERSHIP` without being deleted. The
 * same code reports an extra file inside a skill tree this tool owns.
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
    for (const stale of await findStaleRenders(
      repoRoot,
      prepared.declaredPaths,
      expected,
      recorded,
    )) {
      drift.push({
        code: OUTSIDE_OWNERSHIP_CODE,
        path: stale.path,
        kind: 'unexpected',
        detail: stale.symbolicLink
          ? 'a symbolic link is present where a prior render would be; the lockfile does not record it'
          : 'a plausible prior render is present but the lockfile does not record it',
      });
    }
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
