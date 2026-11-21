import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import type { RendererIdentity } from '../../src/render/port.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createTempRepo, hashTree } from '../support/temp-repo.js';

const IDENTITY: RendererIdentity = {
  name: 'fake-renderer',
  version: '0.0.0-test',
  integrity: 'sha512-fake',
};

describe('renderer identity verification', () => {
  it('refuses a renderer whose version differs from the lockfile with F010 and exit 5', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const before = await hashTree(repo.root);
      await expect(
        runCheck(
          repo.root,
          new FakeRenderTarget({ kind: 'ok' }, { ...IDENTITY, version: '9.9.9' }),
        ),
      ).rejects.toMatchObject({ code: 'F010_RENDERER_MISMATCH', exitCode: 5 });
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a renderer whose integrity differs from the lockfile', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      await expect(
        runCheck(
          repo.root,
          new FakeRenderTarget(
            { kind: 'ok' },
            { ...IDENTITY, integrity: 'sha512-somebody-elses-tarball' },
          ),
        ),
      ).rejects.toMatchObject({ code: 'F010_RENDERER_MISMATCH', exitCode: 5 });
    } finally {
      await repo.cleanup();
    }
  });

  it('checks identity before bytes, so a drifted tree still reports F010', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      await appendFile(join(repo.root, '.claude/agents/builder.md'), 'manual edit\n', 'utf8');
      await expect(
        runCheck(
          repo.root,
          new FakeRenderTarget({ kind: 'ok' }, { ...IDENTITY, version: '9.9.9' }),
        ),
      ).rejects.toMatchObject({ code: 'F010_RENDERER_MISMATCH' });
    } finally {
      await repo.cleanup();
    }
  });

  it('passes when the recorded and installed identities agree', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const result = await runCheck(repo.root, new FakeRenderTarget({ kind: 'ok' }, IDENTITY));
      expect(result.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('skips identity verification when there is no lockfile to compare', async () => {
    const repo = await createTempRepo();
    try {
      const result = await runCheck(repo.root, new FakeRenderTarget({ kind: 'ok' }, IDENTITY));
      expect(result.ok).toBe(false);
      expect(result.drift.map((item) => item.path)).toContain('.farna/lock.json');
    } finally {
      await repo.cleanup();
    }
  });
});
