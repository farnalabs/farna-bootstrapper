import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createTempRepo } from '../support/temp-repo.js';

const UUID = '123e4567-e89b-12d3-a456-426614174000';

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe('the staging namespace', () => {
  it("ignores a killed run's leftovers in check and sweeps them in generate", async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const agentLeftover = join(repo.root, '.claude/agents', `.builder.md.farna-tmp-123-${UUID}`);
      const lockLeftover = join(repo.root, '.farna', `.lock.json.farna-tmp-123-${UUID}`);
      await writeFile(agentLeftover, 'half-written', 'utf8');
      await writeFile(lockLeftover, 'half-written', 'utf8');

      const check = await runCheck(repo.root, new FakeRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.drift).toEqual([]);

      const generated = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new FakeRenderTarget(),
      );
      expect(generated.files.every((file) => file.status === 'unchanged')).toBe(true);
      expect(await exists(agentLeftover)).toBe(false);
      expect(await exists(lockLeftover)).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it('still reports an unrelated hidden file in the managed directory', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      await writeFile(join(repo.root, '.claude/agents/.notes'), 'not ours', 'utf8');
      const check = await runCheck(repo.root, new FakeRenderTarget());
      expect(check.ok).toBe(false);
      expect(check.drift.map((item) => item.path)).toEqual(['.claude/agents/.notes']);
    } finally {
      await repo.cleanup();
    }
  });
});
