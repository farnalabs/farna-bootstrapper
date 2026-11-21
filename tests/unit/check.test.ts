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

  it('ignores an unrecorded agent file in a managed directory', async () => {
    // The tool owns only what the lockfile records. A file the user keeps in
    // `.claude/agents/` is not this tool's output, so `check` must not report
    // its own repository as dirty for it.
    const repo = await generatedRepo();
    try {
      await writeFile(
        join(repo.root, '.claude/agents/extra.md'),
        '---\nname: extra\n---\n',
        'utf8',
      );
      const result = await runCheck(repo.root, new FakeRenderTarget());
      expect(result.ok).toBe(true);
      expect(result.drift).toEqual([]);
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

  it.skipIf(skipSymlinks)(
    'ignores an unrecorded symlink in a managed directory without following it',
    async () => {
      // An unrecorded path is user-owned. `check` neither reports it nor follows
      // it; a symlink at a MANAGED path is still refused (see the next test).
      const repo = await generatedRepo();
      const outside = await createEmptyTempDir();
      try {
        const target = join(outside.root, 'passwd');
        await writeFile(target, 'root:x:0:0\n', 'utf8');
        await symlink(target, join(repo.root, '.claude/agents/evil.md'), 'file');
        const result = await runCheck(repo.root, new FakeRenderTarget());
        expect(result.ok).toBe(true);
        expect(result.drift).toEqual([]);
      } finally {
        await repo.cleanup();
        await outside.cleanup();
      }
    },
  );

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

  it('ignores OS metadata a desktop checkout writes into the managed directory', async () => {
    const repo = await generatedRepo();
    try {
      for (const name of ['.DS_Store', 'Thumbs.db', 'desktop.ini']) {
        await writeFile(join(repo.root, '.claude/agents', name), 'metadata', 'utf8');
      }
      const result = await runCheck(repo.root, new FakeRenderTarget());
      expect(result.ok).toBe(true);
      expect(result.drift).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('compares bytes, so an invalid byte that decodes to U+FFFD is drift and is repaired', async () => {
    const repo = await createTempRepo();
    try {
      // A rule that legitimately contains U+FFFD puts its three UTF-8 bytes
      // into the managed artefact.
      const rulePath = join(repo.root, '.farna/resources/rules/house-style.md');
      const rule = await readFile(rulePath, 'utf8');
      await writeFile(rulePath, `${rule}\nFBS_SENTINEL \uFFFD\n`, 'utf8');
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());

      const managed = join(repo.root, '.claude/agents/builder.md');
      const expected = await readFile(managed);
      const needle = Buffer.from('\uFFFD', 'utf8');
      const at = expected.indexOf(needle);
      expect(at).toBeGreaterThan(-1);
      // Replace the valid U+FFFD with one invalid byte. A lossy UTF-8 decode
      // turns it back into U+FFFD, so a text comparison would call this clean.
      const tampered = Buffer.concat([
        expected.subarray(0, at),
        Buffer.from([0xe9]),
        expected.subarray(at + needle.length),
      ]);
      await writeFile(managed, tampered);
      expect(tampered.toString('utf8')).toBe(expected.toString('utf8'));

      const check = await runCheck(repo.root, new FakeRenderTarget());
      expect(check.ok).toBe(false);
      expect(check.drift.map((item) => item.path)).toContain('.claude/agents/builder.md');

      const regenerated = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new FakeRenderTarget(),
      );
      expect(
        regenerated.files.find((file) => file.path === '.claude/agents/builder.md')?.status,
      ).toBe('written');
      expect((await readFile(managed)).equals(expected)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
