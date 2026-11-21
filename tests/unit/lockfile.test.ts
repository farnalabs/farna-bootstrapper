import { execFileSync } from 'node:child_process';
import { lstat, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { LOCKFILE_MAX_BYTES } from '../../src/core/constants.js';
import { readLockfile } from '../../src/lock/lockfile.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createEmptyTempDir, createTempRepo, type TempRepo } from '../support/temp-repo.js';

const skipSymlinks = process.platform === 'win32';

async function generatedRepo(): Promise<TempRepo> {
  const repo = await createTempRepo();
  await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
  return repo;
}

const LOCK = '.farna/lock.json';

describe('lockfile reading', () => {
  it('validates the whole document and returns it', async () => {
    const repo = await generatedRepo();
    try {
      const lock = await readLockfile(repo.root);
      expect(lock?.schemaVersion).toBe(1);
      expect(lock?.product.name).toBe('farna-bootstrapper');
      expect(lock?.target).toBe('claudecode');
      expect(lock?.mode).toBe('agent');
      expect(lock?.renderer.integrity).toBe('sha512-fake');
      expect(lock?.files.map((file) => file.path)).toEqual([
        '.claude/agents/builder.md',
        '.claude/agents/reviewer.md',
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('returns undefined for a lockfile that misses a required field', async () => {
    const repo = await generatedRepo();
    try {
      const path = join(repo.root, LOCK);
      const lock = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      delete lock['product'];
      await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');

      expect(await readLockfile(repo.root)).toBeUndefined();
      const check = await runCheck(repo.root, new FakeRenderTarget());
      expect(check.ok).toBe(false);
      expect(check.drift.map((item) => item.path)).toContain(LOCK);
    } finally {
      await repo.cleanup();
    }
  });

  it('returns undefined for a malformed document and reports drift', async () => {
    const repo = await generatedRepo();
    try {
      await writeFile(join(repo.root, LOCK), '{"schemaVersion":1}\n', 'utf8');
      expect(await readLockfile(repo.root)).toBeUndefined();
      const check = await runCheck(repo.root, new FakeRenderTarget());
      expect(check.drift.map((item) => item.path)).toContain(LOCK);
    } finally {
      await repo.cleanup();
    }
  });

  it('returns undefined when the lockfile is absent', async () => {
    const repo = await createTempRepo();
    try {
      expect(await readLockfile(repo.root)).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it.skipIf(skipSymlinks)('refuses a symlinked lockfile with F003', async () => {
    const repo = await generatedRepo();
    const outside = await createEmptyTempDir();
    try {
      const path = join(repo.root, LOCK);
      const target = join(outside.root, 'lock.json');
      await rename(path, target);
      await symlink(target, path, 'file');
      await expect(readLockfile(repo.root)).rejects.toMatchObject({
        code: 'F003_PATH_UNSAFE',
        subject: LOCK,
      });
      await expect(runCheck(repo.root, new FakeRenderTarget())).rejects.toMatchObject({
        code: 'F003_PATH_UNSAFE',
      });
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });

  it.skipIf(skipSymlinks)('refuses a FIFO with a typed error and does not hang', async () => {
    const repo = await generatedRepo();
    try {
      const path = join(repo.root, LOCK);
      await rm(path);
      execFileSync('mkfifo', [path]);
      const started = Date.now();
      const outcome = await Promise.race([
        readLockfile(repo.root).then(
          () => 'resolved',
          (error: unknown) => (error as { code?: string }).code ?? 'rejected',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 2_000)),
      ]);
      expect(outcome).toBe('F001_INVALID_CONFIG');
      expect(Date.now() - started).toBeLessThan(2_000);
      await expect(readLockfile(repo.root)).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: LOCK,
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses an oversized lockfile rather than reading it', async () => {
    const repo = await generatedRepo();
    try {
      await writeFile(join(repo.root, LOCK), Buffer.alloc(LOCKFILE_MAX_BYTES + 1, 0x20));
      await expect(readLockfile(repo.root)).rejects.toMatchObject({
        code: 'F003_PATH_UNSAFE',
        subject: LOCK,
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('validates the source root before reading the lockfile', async () => {
    const repo = await generatedRepo();
    try {
      const farna = join(repo.root, '.farna');
      const moved = join(repo.root, 'farna-moved');
      await rename(farna, moved);
      await symlink(moved, farna, 'dir');
      // Neither the lockfile read nor the render runs through a symlinked root.
      await expect(runCheck(repo.root, new FakeRenderTarget())).rejects.toMatchObject({
        code: 'F003_PATH_UNSAFE',
        subject: '.farna',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('names the lockfile when the directory cannot be inspected', async () => {
    const repo = await generatedRepo();
    try {
      const lock = await readLockfile(repo.root);
      expect(lock).toBeDefined();
      expect((await lstat(join(repo.root, LOCK))).isFile()).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
