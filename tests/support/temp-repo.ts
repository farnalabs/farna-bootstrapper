import type { Dirent } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCodepoints, sha256Hex } from '../../src/core/json.js';

export type TempRepo = {
  root: string;
  cleanup: () => Promise<void>;
};

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

/**
 * Copy a fixture into a fresh temporary directory. `demo` is the M1 fixture;
 * `composed` adds `extends`, permissions and the composed builder-python;
 * `opencode` is the same shape on the OpenCode target, with the workspace
 * resource kinds (mcp, skill, command and hook).
 */
export async function createTempRepo(fixture = 'demo'): Promise<TempRepo> {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(join(base, 'fbs-test-'));
  await cp(join(FIXTURES, fixture), root, { recursive: true });
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function createEmptyTempDir(): Promise<TempRepo> {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(join(base, 'fbs-empty-'));
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function listFiles(root: string, current = root): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).split(sep).join('/'));
    }
  }
  return files.sort(compareCodepoints);
}

/** A content hash of the whole tree: path and bytes. Used to prove zero writes. */
export async function hashTree(root: string): Promise<string> {
  const files = await listFiles(root);
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const path of files) {
    entries.push({ path, sha256: sha256Hex(await readFile(join(root, path))) });
  }
  return sha256Hex(JSON.stringify(entries));
}

export async function readText(root: string, path: string): Promise<string> {
  return readFile(join(root, path), 'utf8');
}
