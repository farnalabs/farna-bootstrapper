import { appendFile, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createEmptyTempDir, createTempRepo, hashTree } from '../support/temp-repo.js';

const skipSymlinks = process.platform === 'win32';

async function generatedRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const repo = await createTempRepo();
  await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
  return repo;
}

describe('check', () => {
  it('passes on a clean tree and writes nothing', async () => {
    const repo = await generatedRepo();
    try {
      const before = await hashTree(repo.root);
      const result = await runCheck(repo.root, new FakeRenderTarget());
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.drift).toEqual([]);
      expect(result.checked).toContain('.claude/agents/builder.md');
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('fails and names the path after a manual edit', async () => {
    const repo = await generatedRepo();
    try {
      await appendFile(join(repo.root, '.claude/agents/builder.md'), ' ', 'utf8');
      const edited = await hashTree(repo.root);
      const result = await runCheck(repo.root, new FakeRenderTarget());
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.drift).toEqual([
        {
          code: 'F007_DRIFT',
          path: '.claude/agents/builder.md',
          kind: 'modified',
          detail: 'content differs from a fresh render',
        },
      ]);
      // check never repairs: the edited tree is untouched by the check itself.
      expect(await hashTree(repo.root)).toBe(edited);
    } finally {
      await repo.cleanup();
    }
  });

  it('fails when a managed file is missing', async () => {
    const repo = await generatedRepo();
    try {
      await rm(join(repo.root, '.claude/agents/reviewer.md'));
      const result = await runCheck(repo.root, new FakeRenderTarget());
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.drift.map((item) => [item.path, item.kind])).toEqual([
        ['.claude/agents/reviewer.md', 'missing'],
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('fails when an unexpected agent file is present', async () => {
    const repo = await generatedRepo();
    try {
      await writeFile(
        join(repo.root, '.claude/agents/extra.md'),
        '---\nname: extra\n---\n',
        'utf8',
      );
      const result = await runCheck(repo.root, new FakeRenderTarget());
      expect(result.ok).toBe(false);
      expect(result.drift.map((item) => [item.path, item.kind])).toEqual([
        ['.claude/agents/extra.md', 'unexpected'],
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('fails when the lockfile is stale', async () => {
    const repo = await generatedRepo();
    try {
      await appendFile(join(repo.root, '.farna/lock.json'), '\n', 'utf8');
      const result = await runCheck(repo.root, new FakeRenderTarget());
      expect(result.ok).toBe(false);
      expect(result.drift.map((item) => item.path)).toContain('.farna/lock.json');
    } finally {
      await repo.cleanup();
    }
  });

  it.skipIf(skipSymlinks)('reports a stray symlink in .claude/agents as unexpected', async () => {
    const repo = await generatedRepo();
    const outside = await createEmptyTempDir();
    try {
      const target = join(outside.root, 'passwd');
      await writeFile(target, 'root:x:0:0\n', 'utf8');
      await symlink(target, join(repo.root, '.claude/agents/evil.md'), 'file');
      const result = await runCheck(repo.root, new FakeRenderTarget());
      expect(result.ok).toBe(false);
      expect(result.drift).toEqual([
        {
          code: 'F007_DRIFT',
          path: '.claude/agents/evil.md',
          kind: 'unexpected',
          detail: 'path is not a regular managed file',
        },
      ]);
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });

  it.skipIf(skipSymlinks)(
    'treats a managed file replaced by a symlink as drift, not a match',
    async () => {
      const repo = await generatedRepo();
      const outside = await createEmptyTempDir();
      try {
        const managed = join(repo.root, '.claude/agents/builder.md');
        const target = join(outside.root, 'builder.md');
        // The bytes match, so only an lstat can tell the difference.
        await writeFile(target, await readFile(managed, 'utf8'), 'utf8');
        await rm(managed);
        await symlink(target, managed, 'file');
        const result = await runCheck(repo.root, new FakeRenderTarget());
        expect(result.ok).toBe(false);
        expect(result.drift).toEqual([
          {
            code: 'F007_DRIFT',
            path: '.claude/agents/builder.md',
            kind: 'modified',
            detail: 'managed path is not a regular file',
          },
        ]);
      } finally {
        await repo.cleanup();
        await outside.cleanup();
      }
    },
  );

  it.skipIf(skipSymlinks)('refuses to read through a symlinked .claude/agents', async () => {
    const repo = await generatedRepo();
    const outside = await createEmptyTempDir();
    try {
      const agents = join(repo.root, '.claude/agents');
      const target = join(outside.root, 'agents');
      await rename(agents, target);
      await symlink(target, agents, 'dir');
      await expect(runCheck(repo.root, new FakeRenderTarget())).rejects.toMatchObject({
        code: 'F003_PATH_UNSAFE',
      });
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });
});
