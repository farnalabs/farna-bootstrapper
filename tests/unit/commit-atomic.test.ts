import { lstat, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FarnaError } from '../../src/core/errors.js';
import { commitFiles } from '../../src/render/commit.js';
import { prepareRender } from '../../src/render/prepare.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import {
  createEmptyTempDir,
  createTempRepo,
  hashTree,
  listFiles,
  readText,
} from '../support/temp-repo.js';

async function generatedRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const repo = await createTempRepo();
  await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
  return repo;
}

describe('atomic generate', () => {
  it('leaves every earlier file untouched when a later managed path is a directory', async () => {
    const repo = await generatedRepo();
    try {
      const builderBefore = await readText(repo.root, '.claude/agents/builder.md');
      const reviewerBefore = await readText(repo.root, '.claude/agents/reviewer.md');
      const lockPath = join(repo.root, '.farna/lock.json');
      await rm(lockPath);
      await mkdir(lockPath);
      const before = await hashTree(repo.root);

      let failure: FarnaError | undefined;
      try {
        await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F012_WRITE_FAILED');
      expect(failure?.exitCode).toBe(5);
      expect(failure?.subject).toBe('.farna/lock.json');

      expect(await readText(repo.root, '.claude/agents/builder.md')).toBe(builderBefore);
      expect(await readText(repo.root, '.claude/agents/reviewer.md')).toBe(reviewerBefore);
      expect(await hashTree(repo.root)).toBe(before);
      expect((await stat(lockPath)).isDirectory()).toBe(true);
      expect((await listFiles(repo.root)).filter((path) => path.includes('.farna-tmp'))).toEqual(
        [],
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('reports a rename failure honestly and restores the files it already replaced', async () => {
    const repo = await createTempRepo();
    try {
      const prepared = await prepareRender(repo.root, new FakeRenderTarget());
      const before = await hashTree(repo.root);
      let renames = 0;
      let failure: FarnaError | undefined;
      try {
        await commitFiles(repo.root, prepared.files, {
          rename: async (from, to) => {
            renames += 1;
            if (renames === 2) {
              throw new Error('injected rename failure');
            }
            await rename(from, to);
          },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F012_WRITE_FAILED');
      expect(failure?.message).toContain('earlier files were restored');
      expect(failure?.message).not.toContain('could NOT be restored');
      // The first file was renamed, then removed again by the restore, and the
      // directories this call created were removed too.
      expect(await hashTree(repo.root)).toBe(before);
      expect((await listFiles(repo.root)).filter((path) => path.includes('.farna-tmp'))).toEqual(
        [],
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('names a file it could not restore instead of claiming success', async () => {
    const repo = await generatedRepo();
    try {
      const prepared = await prepareRender(repo.root, new FakeRenderTarget());
      const changed = prepared.files.map((file) => {
        const editable =
          file.path.endsWith('.claude/agents/builder.md') ||
          file.path.endsWith('.claude/agents/reviewer.md');
        return editable ? { ...file, bytes: `${file.bytes}CHANGED\n` } : file;
      });
      let renames = 0;
      let failure: FarnaError | undefined;
      try {
        await commitFiles(repo.root, changed, {
          rename: async (from, to) => {
            renames += 1;
            if (renames === 2) {
              throw new Error('injected rename failure');
            }
            await rename(from, to);
          },
          writeFile: async (path, data) => {
            // Staging writes go to `.farna-tmp-*` siblings; only the restore
            // of the first replaced managed file is made to fail.
            if (path.endsWith('.claude/agents/builder.md')) {
              throw new Error('injected restore failure');
            }
            await writeFile(path, data, 'utf8');
          },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F012_WRITE_FAILED');
      expect(failure?.message).toContain('1 earlier file(s) could NOT be restored');
      expect(failure?.message).toContain('.claude/agents/builder.md');
      // The message is honest: the file really was left with the new bytes.
      expect(await readText(repo.root, '.claude/agents/builder.md')).toContain('CHANGED');
    } finally {
      await repo.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a managed path that is a symlink before writing anything',
    async () => {
      const repo = await generatedRepo();
      const outside = await createEmptyTempDir();
      try {
        const lockPath = join(repo.root, '.farna/lock.json');
        const original = await readFile(lockPath, 'utf8');
        const target = join(outside.root, 'lock.json');
        await rm(lockPath);
        await writeFile(target, original, 'utf8');
        await symlink(target, lockPath, 'file');
        const before = await hashTree(repo.root);
        await expect(
          runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget()),
        ).rejects.toMatchObject({ code: 'F003_PATH_UNSAFE', subject: '.farna/lock.json' });
        expect(await hashTree(repo.root)).toBe(before);
        expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
      } finally {
        await repo.cleanup();
        await outside.cleanup();
      }
    },
  );
});
