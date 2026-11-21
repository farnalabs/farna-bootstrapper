import { lstat, mkdir, readFile, rename, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FarnaError } from '../../src/core/errors.js';
import { commitFiles } from '../../src/render/commit.js';
import { prepareRender } from '../../src/render/prepare.js';
import { sweepStaging } from '../../src/render/staging.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createTempRepo } from '../support/temp-repo.js';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
// A pid that cannot be alive: the maximum pid is far below this on every OS.
const DEAD_PID = 2_147_483_646;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function stagingFile(directory: string, target: string, pid: number): string {
  return join(directory, `.${target}.farna-tmp-${pid}-${UUID}`);
}

describe('the staging namespace', () => {
  it("ignores a killed run's leftovers in check and sweeps them in generate", async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const agents = join(repo.root, '.claude/agents');
      const agentLeftover = stagingFile(agents, 'builder.md', DEAD_PID);
      const lockLeftover = stagingFile(join(repo.root, '.farna'), 'lock.json', DEAD_PID);
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

  it('does not sweep a live process staged file', async () => {
    const repo = await createTempRepo();
    try {
      const agents = join(repo.root, '.claude/agents');
      await mkdir(agents, { recursive: true });
      // This process is alive, so a concurrent generate must not delete the
      // sibling it is about to rename into place.
      const live = stagingFile(agents, 'builder.md', process.pid);
      await writeFile(live, 'still being written', 'utf8');
      await sweepStaging(agents);
      expect(await exists(live)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('sweeps an old leftover even when its pid number was reused', async () => {
    const repo = await createTempRepo();
    try {
      const agents = join(repo.root, '.claude/agents');
      await mkdir(agents, { recursive: true });
      const stale = stagingFile(agents, 'builder.md', process.pid);
      await writeFile(stale, 'crashed long ago', 'utf8');
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(stale, old, old);
      await sweepStaging(agents);
      expect(await exists(stale)).toBe(false);
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

describe('concurrent generate', () => {
  it('tolerates a directory another process created first (EEXIST)', async () => {
    const repo = await createTempRepo();
    try {
      const prepared = await prepareRender(repo.root, new FakeRenderTarget());
      let mkdirs = 0;
      const result = await commitFiles(repo.root, prepared.files, {
        mkdir: async (path) => {
          mkdirs += 1;
          await mkdir(path);
          if (mkdirs === 1) {
            // Another writer won the race between our lstat and mkdir.
            throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
          }
        },
      });
      expect(mkdirs).toBeGreaterThan(0);
      expect(result.statuses.every((entry) => entry.status === 'written')).toBe(true);
      const check = await runCheck(repo.root, new FakeRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("leaves another writer's bytes alone instead of restoring stale ones", async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const prepared = await prepareRender(repo.root, new FakeRenderTarget());
      const changed = prepared.files.map((file) =>
        file.path.endsWith('.claude/agents/builder.md') ||
        file.path.endsWith('.claude/agents/reviewer.md')
          ? { ...file, bytes: `${file.bytes}NEW\n` }
          : file,
      );
      let renames = 0;
      let failure: FarnaError | undefined;
      try {
        await commitFiles(repo.root, changed, {
          rename: async (from, to) => {
            renames += 1;
            if (renames === 2) {
              // A concurrent generate wins the first target between our rename
              // and our rollback.
              await writeFile(join(repo.root, '.claude/agents/builder.md'), 'WINNER\n', 'utf8');
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
      expect(failure?.message).toContain('left as another writer left them');
      expect(await readFile(join(repo.root, '.claude/agents/builder.md'), 'utf8')).toBe('WINNER\n');
    } finally {
      await repo.cleanup();
    }
  });
});
