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
import {
  entryKey,
  type LockFileEntry,
  type RenderedFile,
  readLockfile,
} from '../../lock/lockfile.js';
import { verifyRendererIdentity } from '../../render/identity.js';
import type { RenderTarget } from '../../render/port.js';
import { prepareRender } from '../../render/prepare.js';
import {
  normaliseRegionBody,
  parseManagedRegionBytes,
  regionBody,
  regionIdOf,
} from '../../render/region.js';
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

/** One configured target's comparison. */
export type CheckTargetResult = {
  target: string;
  mode: RenderMode;
  activePersona: string | null;
  /** Personas resolved but not live. Empty in agent mode. */
  notLive: string[];
  checked: string[];
  drift: DriftItem[];
};

/**
 * A run-level path that was deliberately not compared. It is neither a match
 * nor drift: a version 1 lockfile is left alone until the next `generate`
 * upgrades it, so calling it "checked" would claim a comparison that never ran.
 */
export type PendingItem = {
  path: string;
  detail: string;
};

export type CheckResult = {
  ok: boolean;
  exitCode: 0 | typeof EXIT.drift;
  /** One entry per configured target, in target-id order. */
  targets: CheckTargetResult[];
  /**
   * Run-level managed paths outside any target (the lockfile) whose bytes were
   * actually compared and matched.
   */
  checked: string[];
  /** Run-level drift outside any target: the lockfile digest item. */
  drift: DriftItem[];
  /** Run-level paths deliberately not compared, with the reason. Never drift. */
  pending: PendingItem[];
  warnings: Warning[];
};

/** Every drift item, across every target and the run, in path order. */
export function allCheckDrift(result: CheckResult): DriftItem[] {
  return [...result.targets.flatMap((target) => target.drift), ...result.drift].sort((a, b) =>
    compareCodepoints(a.path, b.path),
  );
}

/** The detail `check` prints for a whole file whose bytes changed. */
const MODIFIED_DETAIL = 'content differs from a fresh render';
const MISSING_DETAIL = 'managed file is missing';
const NOT_A_FILE_DETAIL = 'managed path is not a regular file';
const REGION_MISSING_DETAIL = 'the managed region is missing';

/**
 * Compare one planned artefact against the working tree.
 *
 * A whole file is compared by bytes. A structured file is compared by its owned
 * keys only. A region file is read, decoded strictly, parsed and compared by the
 * body between its markers only: every byte outside the region is the user's, so
 * editing it is not drift, while a missing or changed region is. A malformed,
 * CRLF or non-UTF-8 region file is a typed F001 naming the line, because
 * ownership cannot be determined safely; it is never reported as ordinary drift
 * and never repaired.
 */
export async function compareManagedFile(
  repoRoot: string,
  file: RenderedFile,
): Promise<DriftItem | undefined> {
  const absolute = await containedTarget(repoRoot, file.path);
  const stats = await lstatOrUndefined(absolute, file.path);
  if (stats === undefined) {
    return { code: DRIFT_CODE, path: file.path, kind: 'missing', detail: MISSING_DETAIL };
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return {
      code: DRIFT_CODE,
      path: file.path,
      kind: 'modified',
      detail: NOT_A_FILE_DETAIL,
    };
  }

  const regionId = regionIdOf(file.path);
  if (regionId !== undefined) {
    const existing = await readBoundedBytes(absolute, file.path, {
      action: 'make the managed file readable and re-run check',
      maxBytes: MANAGED_FILE_MAX_BYTES,
    });
    const parsed = parseManagedRegionBytes(existing, file.path, [regionId]);
    const body = regionBody(parsed, regionId);
    if (body === undefined) {
      return {
        code: DRIFT_CODE,
        path: file.path,
        kind: 'missing',
        detail: REGION_MISSING_DETAIL,
      };
    }
    if (body !== normaliseRegionBody(file.bytes)) {
      return {
        code: DRIFT_CODE,
        path: file.path,
        kind: 'modified',
        detail: `region "${regionId}" differs from a fresh render`,
      };
    }
    return undefined;
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
      return {
        code: DRIFT_CODE,
        path: file.path,
        kind: 'modified',
        detail: 'structured file no longer parses as a JSON object',
      };
    }
    const generated = parseStructuredDocument(file.bytes, file.path);
    if (existingOwned !== canonicalOwnedSubset(generated, ownedKeys)) {
      return {
        code: DRIFT_CODE,
        path: file.path,
        kind: 'modified',
        detail: `owned key(s) ${ownedKeys.join(', ')} differ from a fresh render`,
      };
    }
    return undefined;
  }

  const existing = await readBoundedBytes(absolute, file.path, {
    action: 'make the managed file readable and re-run check',
    maxBytes: MANAGED_FILE_MAX_BYTES,
  });
  if (!existing.equals(Buffer.from(file.bytes, 'utf8'))) {
    return {
      code: DRIFT_CODE,
      path: file.path,
      kind: 'modified',
      detail: MODIFIED_DETAIL,
    };
  }
  return undefined;
}

/** One recorded entry the source no longer produces, and the target that recorded it. */
export type UnproducedEntry = { targetId: string; item: DriftItem };

/**
 * Every recorded entry the current source no longer produces, keyed by
 * `entryKey`: a recorded region whose own key is still produced is not drift
 * merely because another region of the same file was removed, and a recorded
 * region the source no longer produces is drift even when the file remains for
 * another region.
 */
export function unproducedEntryDrift(
  recorded: readonly { targetId: string; files: readonly LockFileEntry[] }[],
  expected: ReadonlySet<string>,
): UnproducedEntry[] {
  const drift: UnproducedEntry[] = [];
  for (const { targetId, files } of recorded) {
    for (const file of files) {
      if (expected.has(entryKey(file))) {
        continue;
      }
      const detail =
        file.shape === 'region' && file.regionId !== undefined
          ? `region "${file.regionId}" is recorded in the lockfile but no longer produced by this source`
          : 'path is recorded in the lockfile but no longer produced by this source';
      drift.push({
        targetId,
        item: { code: DRIFT_CODE, path: file.path, kind: 'unexpected', detail },
      });
    }
  }
  return drift;
}

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
 * editing the `mcp` value this tool wrote is. A `region` file is compared by the
 * body between its markers for the same reason: prose outside the region is the
 * user's, and a malformed or non-LF file is a typed refusal rather than drift.
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
  // A source change that renders no different byte — an edit to a persona that
  // is not live, a rule only that persona declares — is still a change to the
  // committed record. Comparing the digest is what makes it visible.
  const digestChanged =
    lockfile?.configDigest !== undefined && lockfile.configDigest !== prepared.configDigest;

  // Every configured target is compared in its own section. A target's own
  // artefacts, its own skill-tree scan and its own mode stay together, so a
  // mixed run never has to be untangled by the reader.
  const targets: CheckTargetResult[] = [];
  for (const target of prepared.targets) {
    const drift: DriftItem[] = [];
    for (const file of target.files) {
      const item = await compareManagedFile(repoRoot, file);
      if (item !== undefined) {
        drift.push(item);
      }
    }
    if (target.source.mode === MODE_PROFILE) {
      const planned = new Set(target.files.map((file) => file.path));
      const recordedEntries = lockfile?.targets[target.source.target]?.files ?? [];
      for (const extra of await findSkillTreeExtras(repoRoot, planned, recordedEntries)) {
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
    targets.push({
      target: target.source.target,
      mode: target.source.mode,
      activePersona: target.source.active,
      notLive: target.source.notLive,
      checked: target.files.map((file) => file.path),
      drift,
    });
  }

  // The lockfile belongs to the run, not to one target. Its bytes are compared
  // once, and the report must say exactly what happened: a path is "checked"
  // only when its bytes were compared and matched, "pending" only when a
  // deliberate decision skipped the comparison, and drift otherwise.
  const runChecked: string[] = [];
  const runDrift: DriftItem[] = [];
  const runPending: PendingItem[] = [];
  const freshLockfile = prepared.files.find((file) => file.path === LOCK_PATH);
  if (digestChanged) {
    // The digest names the cause, so the bytes are not compared. The lockfile
    // is drift, never also "checked" or "pending".
    runDrift.push({
      code: DRIFT_CODE,
      path: LOCK_PATH,
      kind: 'modified',
      detail: 'the source or config changed since the lockfile was written; re-run generate',
    });
  } else if (lockfile?.readVersion === 1) {
    // The migration case: `check` continues to pass on a version 1 document
    // until the next `generate` rewrites it as version 2, so the format
    // upgrade is neither drift nor a comparison that ran.
    runPending.push({
      path: LOCK_PATH,
      detail: 'version 1 record; run generate to upgrade it to version 2',
    });
  } else if (freshLockfile !== undefined) {
    const item = await compareManagedFile(repoRoot, freshLockfile);
    if (item !== undefined) {
      runDrift.push(item);
    } else {
      runChecked.push(LOCK_PATH);
    }
  }

  const expected = new Set(prepared.files.map((file) => entryKey(file)));
  // A recorded entry the current source no longer produces is drift whether or
  // not it is still on disk: removing the last declaration must not leave a
  // live config that `check` calls clean. Only the lockfile can name it; the
  // on-disk scan is deliberately gone, because an unrecorded path is not ours.
  // The comparison is against the keyed union of recorded entries, so a region
  // another entry still produces is not drift; the item is reported under the
  // target that recorded it.
  const recordedTargets = Object.entries(lockfile?.targets ?? {}).map(([targetId, entry]) => ({
    targetId,
    files: entry.files,
  }));
  for (const { targetId, item } of unproducedEntryDrift(recordedTargets, expected)) {
    const bucket = targets.find((target) => target.target === targetId);
    if (bucket === undefined) {
      runDrift.push(item);
    } else {
      bucket.drift.push(item);
    }
  }

  for (const target of targets) {
    target.drift.sort((a, b) => compareCodepoints(a.path, b.path));
  }
  runDrift.sort((a, b) => compareCodepoints(a.path, b.path));
  const allDrift = [...targets.flatMap((target) => target.drift), ...runDrift];

  return {
    ok: allDrift.length === 0,
    exitCode: allDrift.length === 0 ? EXIT.ok : EXIT.drift,
    targets,
    checked: runChecked,
    drift: runDrift,
    pending: runPending,
    warnings: prepared.warnings,
  };
}
