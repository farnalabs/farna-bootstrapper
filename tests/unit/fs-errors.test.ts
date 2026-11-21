import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { runInit } from '../../src/cli/commands/init.js';
import { resolveSource } from '../../src/compose/resolve.js';
import { loadConfig } from '../../src/config/load.js';
import { MANAGED_FILE_MAX_BYTES, SOURCE_MAX_BYTES } from '../../src/core/constants.js';
import { readLockfile } from '../../src/lock/lockfile.js';
import { withStage } from '../../src/render/stage.js';
import { loadSource } from '../../src/source/load.js';
import { verifyRender } from '../../src/verify/containment.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createTempRepo } from '../support/temp-repo.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

async function withEnv(
  name: string,
  value: string | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const original = process.env[name];
  try {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
    await run();
  } finally {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
}

describe('untyped filesystem failures become typed diagnostics', () => {
  it('names a missing temporary directory instead of throwing ENOENT', async () => {
    const base = await realpath(tmpdir());
    const missing = join(base, 'farna-bootstrapper-does-not-exist');
    await withEnv('TMPDIR', missing, async () => {
      const outcome = await withStage(async () => 'unreachable').then(
        () => 'resolved',
        (error: { code?: string; subject?: string; message?: string }) => error,
      );
      expect(outcome).toMatchObject({ code: 'F009_RENDER_FAILED', subject: 'temporary stage' });
      if (typeof outcome === 'object') {
        expect(outcome.message).toContain('configured temporary directory');
        // The configured absolute host path is never echoed in a diagnostic.
        expect(outcome.message).not.toContain(missing);
      }
    });
  });

  it.skipIf(isRoot)('names a read-only temporary directory', async () => {
    const base = await realpath(tmpdir());
    const readOnly = await mkdtemp(join(base, 'fbs-ro-'));
    try {
      await chmod(readOnly, 0o500);
      await withEnv('TMPDIR', readOnly, async () => {
        await expect(withStage(async () => 'unreachable')).rejects.toMatchObject({
          code: 'F009_RENDER_FAILED',
          subject: 'temporary stage',
        });
      });
    } finally {
      await chmod(readOnly, 0o700);
      await rm(readOnly, { recursive: true, force: true });
    }
  });

  it.skipIf(isRoot)('names an unreadable persona by its repository path', async () => {
    const repo = await createTempRepo();
    const persona = join(repo.root, '.farna/personas/builder.yaml');
    try {
      await chmod(persona, 0o000);
      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget()),
      ).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: '.farna/personas/builder.yaml',
      });
    } finally {
      await chmod(persona, 0o600);
      await repo.cleanup();
    }
  });

  it.skipIf(isRoot)('names an unreadable managed directory by its repository path', async () => {
    const repo = await createTempRepo();
    const agents = join(repo.root, '.claude/agents');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      await chmod(agents, 0o000);
      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget()),
      ).rejects.toMatchObject({
        code: 'F003_PATH_UNSAFE',
        subject: '.claude/agents/builder.md',
      });
      await expect(runCheck(repo.root, new FakeRenderTarget())).rejects.toBeInstanceOf(Error);
    } finally {
      await chmod(agents, 0o755);
      await repo.cleanup();
    }
  });

  it.skipIf(isRoot)('names an unreadable lockfile by its repository path', async () => {
    const repo = await createTempRepo();
    const lock = join(repo.root, '.farna/lock.json');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      await chmod(lock, 0o000);
      await expect(readLockfile(repo.root)).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: '.farna/lock.json',
      });
    } finally {
      await chmod(lock, 0o600);
      await repo.cleanup();
    }
  });

  it.skipIf(isRoot)(
    'names the config by its repository path when .farna denies search',
    async () => {
      const repo = await createTempRepo();
      const farna = join(repo.root, '.farna');
      try {
        await chmod(farna, 0o000);
        await expect(runInit(repo.root)).rejects.toMatchObject({
          code: 'F003_PATH_UNSAFE',
          subject: '.farna/config.jsonc',
        });
      } finally {
        await chmod(farna, 0o755);
        await repo.cleanup();
      }
    },
  );

  it.skipIf(isRoot)(
    'names an emitted artefact when its stage directory denies search',
    async () => {
      const repo = await createTempRepo();
      const denied = await mkdtemp(join(await realpath(tmpdir()), 'fbs-denied-'));
      try {
        const config = await loadConfig(repo.root);
        const source = resolveSource(await loadSource(repo.root), config);
        const emitted = ['.claude/agents/builder.md', '.claude/agents/reviewer.md'];
        await chmod(denied, 0o000);
        await expect(
          verifyRender(
            source,
            { target: 'claudecode', files: emitted, sourceLoadFailed: false },
            join(denied, 'out'),
          ),
        ).rejects.toMatchObject({ code: 'F003_PATH_UNSAFE', subject: emitted[0] });
      } finally {
        await chmod(denied, 0o700);
        await rm(denied, { recursive: true, force: true });
        await repo.cleanup();
      }
    },
  );

  it('refuses an oversized managed file with a relative subject instead of a string-length crash', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const managed = join(repo.root, '.claude/agents/builder.md');
      await writeFile(managed, Buffer.alloc(MANAGED_FILE_MAX_BYTES + 1, 0x20));
      for (const run of [
        () => runCheck(repo.root, new FakeRenderTarget()),
        () => runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget()),
      ]) {
        await expect(run()).rejects.toMatchObject({
          code: 'F003_PATH_UNSAFE',
          subject: '.claude/agents/builder.md',
        });
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses an oversized source file with a relative subject', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/config.jsonc'),
        Buffer.alloc(SOURCE_MAX_BYTES + 1, 0x20),
      );
      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget()),
      ).rejects.toMatchObject({
        code: 'F003_PATH_UNSAFE',
        subject: '.farna/config.jsonc',
      });
    } finally {
      await repo.cleanup();
    }
  });
});
