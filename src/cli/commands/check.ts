import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CLAUDE_AGENTS_DIR,
  CLAUDE_DIR,
  DRIFT_CODE,
  EXIT,
  LOCK_PATH,
  ROOT_DIR,
} from '../../core/constants.js';
import { invalidConfig } from '../../core/errors.js';
import { describeFsError } from '../../core/fs.js';
import { compareCodepoints } from '../../core/json.js';
import {
  assertNoSymlink,
  assertRealDirectory,
  containedTarget,
  lstatOrUndefined,
} from '../../core/paths.js';
import { readLockfile } from '../../lock/lockfile.js';
import { verifyRendererIdentity } from '../../render/identity.js';
import type { RenderTarget } from '../../render/port.js';
import { prepareRender } from '../../render/prepare.js';
import { isStagingName } from '../../render/staging.js';
import type { Warning } from '../../report/warnings.js';

export type DriftKind = 'missing' | 'modified' | 'unexpected';

export type DriftItem = {
  code: typeof DRIFT_CODE;
  path: string;
  kind: DriftKind;
  detail: string;
};

export type CheckResult = {
  ok: boolean;
  target: string;
  exitCode: 0 | typeof EXIT.drift;
  checked: string[];
  drift: DriftItem[];
  warnings: Warning[];
};

type AgentEntry = { path: string; regular: boolean };

/**
 * List `.claude/agents`. The tool's own staging namespace is ignored (a killed
 * run's leftover is not user content), but nothing else is filtered: a
 * directory, a symbolic link or a device node is an entry the managed set does
 * not contain, so it is unexpected rather than invisible.
 */
async function listAgentEntries(repoRoot: string): Promise<AgentEntry[]> {
  const claude = await assertNoSymlink(join(repoRoot, CLAUDE_DIR), CLAUDE_DIR);
  if (claude !== undefined && !claude.isDirectory()) {
    throw invalidConfig(`${CLAUDE_DIR} is not a directory`, { subject: CLAUDE_DIR });
  }
  const dir = join(repoRoot, CLAUDE_AGENTS_DIR);
  const stats = await assertNoSymlink(dir, CLAUDE_AGENTS_DIR);
  if (stats === undefined) {
    return [];
  }
  if (!stats.isDirectory()) {
    throw invalidConfig(`${CLAUDE_AGENTS_DIR} is not a directory`, {
      subject: CLAUDE_AGENTS_DIR,
    });
  }
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw invalidConfig(`cannot read ${CLAUDE_AGENTS_DIR} (${describeFsError(error)})`, {
      subject: CLAUDE_AGENTS_DIR,
      action: 'make the directory readable and re-run check',
      cause: error,
    });
  }
  return entries
    .filter((entry) => !isStagingName(entry.name))
    .map((entry) => ({
      path: `${CLAUDE_AGENTS_DIR}/${entry.name}`,
      regular: entry.isFile(),
    }))
    .sort((a, b) => compareCodepoints(a.path, b.path));
}

/**
 * Regenerate into a disposable stage and compare the result with the working
 * tree. Never writes. Exit 0 when identical, 1 when anything drifted.
 *
 * The source root is validated before the lockfile is read, so a broken source
 * tree is reported as itself rather than after a lockfile read. The renderer
 * identity recorded in the lockfile is checked next: a renderer that is not the
 * one that produced the committed bytes fails F010 (exit 5) before any byte
 * comparison, so drift is never blamed on the wrong cause.
 */
export async function runCheck(repoRoot: string, renderer: RenderTarget): Promise<CheckResult> {
  await assertRealDirectory(join(repoRoot, ROOT_DIR), ROOT_DIR);

  const lockfile = await readLockfile(repoRoot);
  if (lockfile !== undefined) {
    verifyRendererIdentity(lockfile.renderer, renderer.identity(), LOCK_PATH);
  }

  const prepared = await prepareRender(repoRoot, renderer);
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
    const existing = await readFile(absolute, 'utf8');
    if (existing !== file.bytes) {
      drift.push({
        code: DRIFT_CODE,
        path: file.path,
        kind: 'modified',
        detail: 'content differs from a fresh render',
      });
    }
  }

  const expected = new Set(prepared.files.map((file) => file.path));
  for (const entry of await listAgentEntries(repoRoot)) {
    if (!expected.has(entry.path)) {
      drift.push({
        code: DRIFT_CODE,
        path: entry.path,
        kind: 'unexpected',
        detail: entry.regular
          ? 'path is not recorded as managed output'
          : 'path is not a regular managed file',
      });
    }
  }

  drift.sort((a, b) => compareCodepoints(a.path, b.path));
  return {
    ok: drift.length === 0,
    target: prepared.source.target,
    exitCode: drift.length === 0 ? EXIT.ok : EXIT.drift,
    checked: prepared.files.map((file) => file.path),
    drift,
    warnings: prepared.source.warnings,
  };
}
