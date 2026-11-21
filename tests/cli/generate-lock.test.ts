import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptyTempDir } from '../support/temp-repo.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const DRIVER = join(ROOT, 'tests', 'support', 'lock-holder.mjs');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function runDriver(repoRoot: string, result: string, mode: 'hold' | 'try'): Promise<void> {
  await execFileAsync(process.execPath, [DRIVER, repoRoot, result, mode], {
    cwd: ROOT,
    timeout: 30_000,
  });
}

async function waitForResult(result: string, text: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    let contents = '';
    try {
      contents = await readFile(result, 'utf8');
    } catch {
      contents = '';
    }
    if (contents.includes(text)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for "${text}" in the lock result`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('the generate lock across processes', () => {
  beforeAll(async () => {
    await execFileAsync(NPM, ['run', 'build'], { cwd: ROOT, timeout: 180_000 });
  }, 180_000);

  it('admits exactly one holder out of eight concurrent processes', async () => {
    const repo = await createEmptyTempDir();
    try {
      await mkdir(join(repo.root, '.farna'));
      const result = join(repo.root, 'result.txt');

      // The holder acquires first and waits, so the other seven contend while
      // the lock is provably held.
      const holder = runDriver(repo.root, result, 'hold');
      await waitForResult(result, 'acquired');

      const contenders = await Promise.allSettled(
        Array.from({ length: 7 }, async () => await runDriver(repo.root, result, 'try')),
      );
      expect(contenders.every((entry) => entry.status === 'fulfilled')).toBe(true);

      // Release the holder; it removes the lock directory.
      await writeFile(join(repo.root, 'release'), '', 'utf8');
      await holder;
      await waitForResult(result, 'released');

      const lines = (await readFile(result, 'utf8')).trim().split('\n');
      const acquired = lines.filter((line) => line.startsWith('acquired'));
      const refused = lines.filter((line) => line.startsWith('refused'));
      expect(acquired).toHaveLength(1);
      expect(refused).toHaveLength(7);
      expect(refused.every((line) => line.endsWith('F001_INVALID_CONFIG'))).toBe(true);

      // The lock directory is gone, so a later run can take it immediately.
      await expect(access(join(repo.root, '.farna', '.generate.lock'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await repo.cleanup();
    }
  }, 60_000);
});
