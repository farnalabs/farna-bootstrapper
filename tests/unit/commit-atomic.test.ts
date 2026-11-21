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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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

  it('records each created ancestor so a partial mkdir failure rolls back', async () => {
    const repo = await createTempRepo();
    try {
      const prepared = await prepareRender(repo.root, new FakeRenderTarget());
      let mkdirCalls = 0;
      let failure: FarnaError | undefined;
      try {
        await commitFiles(repo.root, prepared.files, {
          mkdir: async (path) => {
            mkdirCalls += 1;
            // `.claude` is created first; the second level (`.claude/agents`)
            // fails after it. The old code recorded neither because the
            // recursive mkdir had not returned.
            if (mkdirCalls === 2) {
              throw new Error('injected mkdir failure');
            }
            await mkdir(path);
          },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        failure = error as FarnaError;
      }
      expect(mkdirCalls).toBe(2);
      expect(failure?.code).toBe('F012_WRITE_FAILED');
      expect(failure?.message).toContain('nothing was written');
      // The directory the recursive call could have left behind is gone.
      expect(await exists(join(repo.root, '.claude'))).toBe(false);
      expect((await listFiles(repo.root)).filter((path) => path.includes('.farna-tmp'))).toEqual(
        [],
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('names a directory the rollback could not remove instead of claiming a clean tree', async () => {
    const repo = await createTempRepo();
    try {
      const prepared = await prepareRender(repo.root, new FakeRenderTarget());
      let mkdirCalls = 0;
      let failure: FarnaError | undefined;
      try {
        await commitFiles(repo.root, prepared.files, {
          mkdir: async (path) => {
            mkdirCalls += 1;
            if (mkdirCalls === 2) {
              throw new Error('injected mkdir failure');
            }
            await mkdir(path);
          },
          removeDirectory: async () => {
            throw new Error('injected rmdir failure');
          },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F012_WRITE_FAILED');
      expect(failure?.message).toContain('could not be removed');
      expect(failure?.message).toContain('.claude');
      // Clean up what the injected failure left on disk.
      await rm(join(repo.root, '.claude'), { recursive: true, force: true });
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
              throw Object.assign(new Error('EACCES: permission denied, open /super/secret/path'), {
                code: 'EACCES',
              });
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
      // The failure carries the filesystem code, never the absolute host path
      // the platform error spelling contains.
      expect(failure?.message).toContain('EACCES');
      expect(failure?.message).not.toContain('/super/secret/path');
      expect(failure?.message).not.toContain(repo.root);
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

  it('restores a replaced managed file byte for byte when it is not valid UTF-8', async () => {
    const repo = await generatedRepo();
    try {
      const managed = join(repo.root, '.claude/agents/builder.md');
      // A Latin-1 file is not valid UTF-8. A text round-trip would replace the
      // 0xE9 byte with U+FFFD and write that back, corrupting the file it was
      // supposed to restore.
      const original = Buffer.from([0x23, 0x20, 0xe9, 0x0a]);
      await writeFile(managed, original);

      const prepared = await prepareRender(repo.root, new FakeRenderTarget());
      const changed = prepared.files.map((file) =>
        file.path.endsWith('.claude/agents/builder.md') ||
        file.path.endsWith('.claude/agents/reviewer.md')
          ? { ...file, bytes: `${file.bytes}CHANGED\n` }
          : file,
      );
      let renames = 0;
      await expect(
        commitFiles(repo.root, changed, {
          rename: async (from, to) => {
            renames += 1;
            if (renames === 2) {
              throw new Error('injected rename failure');
            }
            await rename(from, to);
          },
        }),
      ).rejects.toMatchObject({ code: 'F012_WRITE_FAILED' });

      const restored = await readFile(managed);
      expect(restored.equals(original)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
