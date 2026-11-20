import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_AGENTS_DIR } from '../../core/constants.js';
import { compareCodepoints } from '../../core/json.js';
import type { RenderTarget } from '../../render/port.js';
import { prepareRender } from '../../render/prepare.js';

export type DriftKind = 'missing' | 'modified' | 'unexpected';

export type DriftItem = {
  code: 'F007_DRIFT';
  path: string;
  kind: DriftKind;
  detail: string;
};

export type CheckResult = {
  ok: boolean;
  target: string;
  exitCode: 0 | 1;
  checked: string[];
  drift: DriftItem[];
};

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function listAgentsDir(repoRoot: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(repoRoot, CLAUDE_AGENTS_DIR), { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => `${CLAUDE_AGENTS_DIR}/${entry.name}`)
    .sort(compareCodepoints);
}

/**
 * Regenerate into a disposable stage and compare the result with the working
 * tree. Never writes. Exit 0 when identical, 1 when anything drifted.
 */
export async function runCheck(repoRoot: string, renderer: RenderTarget): Promise<CheckResult> {
  const prepared = await prepareRender(repoRoot, renderer);
  const drift: DriftItem[] = [];

  for (const file of prepared.files) {
    const existing = await readOptional(join(repoRoot, file.path));
    if (existing === undefined) {
      drift.push({
        code: 'F007_DRIFT',
        path: file.path,
        kind: 'missing',
        detail: 'managed file is missing',
      });
      continue;
    }
    if (existing !== file.bytes) {
      drift.push({
        code: 'F007_DRIFT',
        path: file.path,
        kind: 'modified',
        detail: 'content differs from a fresh render',
      });
    }
  }

  const expected = new Set(prepared.files.map((file) => file.path));
  for (const path of await listAgentsDir(repoRoot)) {
    if (!expected.has(path)) {
      drift.push({
        code: 'F007_DRIFT',
        path,
        kind: 'unexpected',
        detail: 'path is not recorded as managed output',
      });
    }
  }

  drift.sort((a, b) => compareCodepoints(a.path, b.path));
  return {
    ok: drift.length === 0,
    target: prepared.source.target,
    exitCode: drift.length === 0 ? 0 : 1,
    checked: prepared.files.map((file) => file.path),
    drift,
  };
}
