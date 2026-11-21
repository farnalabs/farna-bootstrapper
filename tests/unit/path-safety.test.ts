import { mkdir, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FarnaError } from '../../src/core/errors.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import {
  createEmptyTempDir,
  createTempRepo,
  hashTree,
  type TempRepo,
} from '../support/temp-repo.js';

// Creating a symlink on Windows needs a privilege the CI runner does not have.
// The skip is explicit and named; CI runs this suite on Linux.
const skipSymlinks = process.platform === 'win32';

async function expectRefusal(repo: TempRepo): Promise<FarnaError> {
  const before = await hashTree(repo.root);
  try {
    await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
  } catch (error) {
    expect(error).toBeInstanceOf(FarnaError);
    expect((error as FarnaError).code).toBe('F003_PATH_UNSAFE');
    expect(await hashTree(repo.root)).toBe(before);
    return error as FarnaError;
  }
  throw new Error('expected a path-safety refusal, but generate succeeded');
}

describe.skipIf(skipSymlinks)('symlinked output paths (skipped on Windows)', () => {
  it('refuses .claude symlinked outside the repository and writes nothing', async () => {
    const repo = await createTempRepo();
    const outside = await createEmptyTempDir();
    try {
      await symlink(outside.root, join(repo.root, '.claude'), 'dir');
      const error = await expectRefusal(repo);
      expect(error.subject).toBe('.claude');
      expect(await readdir(outside.root)).toEqual([]);
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });

  it('refuses .claude symlinked inside the repository, which a prefix check would allow', async () => {
    const repo = await createTempRepo();
    const inside = join(repo.root, 'dotfiles');
    try {
      await mkdir(inside, { recursive: true });
      await symlink(inside, join(repo.root, '.claude'), 'dir');
      const before = await hashTree(repo.root);
      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget()),
      ).rejects.toMatchObject({ code: 'F003_PATH_UNSAFE' });
      expect(await hashTree(repo.root)).toBe(before);
      expect(await readdir(inside)).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses .claude/agents symlinked inside the repository', async () => {
    const repo = await createTempRepo();
    const inside = join(repo.root, 'dotfiles', 'agents');
    try {
      await mkdir(inside, { recursive: true });
      await mkdir(join(repo.root, '.claude'), { recursive: true });
      await symlink(inside, join(repo.root, '.claude', 'agents'), 'dir');
      const error = await expectRefusal(repo);
      expect(error.subject).toBe('.claude/agents');
      expect(await readdir(inside)).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a symlinked .claude/agents in --dry-run instead of reading outside the repo', async () => {
    const repo = await createTempRepo();
    const outside = await createEmptyTempDir();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const agents = join(repo.root, '.claude', 'agents');
      const target = join(outside.root, 'agents');
      await rename(agents, target);
      await symlink(target, agents, 'dir');
      await expect(
        runGenerate({ cwd: repo.root, dryRun: true }, new FakeRenderTarget()),
      ).rejects.toMatchObject({ code: 'F003_PATH_UNSAFE', subject: '.claude/agents' });
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });

  it('turns a .claude file into a typed F003 in --dry-run', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(join(repo.root, '.claude'), 'not a directory', 'utf8');
      await expect(
        runGenerate({ cwd: repo.root, dryRun: true }, new FakeRenderTarget()),
      ).rejects.toMatchObject({ code: 'F003_PATH_UNSAFE', subject: '.claude' });
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses .claude/agents symlinked outside the repository', async () => {
    const repo = await createTempRepo();
    const outside = await createEmptyTempDir();
    try {
      await mkdir(join(repo.root, '.claude'), { recursive: true });
      await symlink(outside.root, join(repo.root, '.claude', 'agents'), 'dir');
      const error = await expectRefusal(repo);
      expect(error.subject).toBe('.claude/agents');
      expect(await readdir(outside.root)).toEqual([]);
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });
});

describe.skipIf(skipSymlinks)('symlinked source paths (skipped on Windows)', () => {
  const levels = [
    ['.farna', '.farna'],
    ['.farna/personas', '.farna/personas'],
    ['.farna/resources', '.farna/resources'],
    ['.farna/resources/rules', '.farna/resources/rules'],
    ['.farna/resources/permissions', '.farna/resources/permissions'],
  ] as const;

  for (const [relative, subject] of levels) {
    it(`refuses a symlinked ${relative}`, async () => {
      const repo = await createTempRepo('composed');
      const outside = await createEmptyTempDir();
      try {
        const target = join(outside.root, 'source');
        await rename(join(repo.root, relative), target);
        await symlink(target, join(repo.root, relative), 'dir');
        const error = await expectRefusal(repo);
        expect(error.subject).toBe(subject);
      } finally {
        await repo.cleanup();
        await outside.cleanup();
      }
    });
  }

  it('refuses a symlinked .farna/config.jsonc', async () => {
    const repo = await createTempRepo();
    const outside = await createEmptyTempDir();
    try {
      const target = join(outside.root, 'config.jsonc');
      await rename(join(repo.root, '.farna/config.jsonc'), target);
      await symlink(target, join(repo.root, '.farna/config.jsonc'), 'file');
      const error = await expectRefusal(repo);
      expect(error.subject).toBe('.farna/config.jsonc');
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });
});
