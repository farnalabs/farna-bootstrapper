import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { readLockfile } from '../../src/lock/lockfile.js';
import type { RendererIdentity } from '../../src/render/port.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createTempRepo, hashTree } from '../support/temp-repo.js';

const IDENTITY: RendererIdentity = {
  name: 'fake-renderer',
  version: '0.0.0-test',
  integrity: 'sha512-fake',
};

/** The build's pin: recorded in the lockfile, independent of the machine. */
const PIN: RendererIdentity = {
  name: 'fake-renderer',
  version: '0.0.0-test',
  integrity: 'sha512-pin',
};

const WITHOUT_INTEGRITY: RendererIdentity = {
  name: 'fake-renderer',
  version: '0.0.0-test',
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

  it('records the pin rather than the installed integrity', async () => {
    const repo = await createTempRepo();
    try {
      // This machine's package manager recorded nothing, which used to make the
      // lockfile omit integrity and drift against a machine that recorded one.
      await runGenerate(
        { cwd: repo.root, dryRun: false },
        new FakeRenderTarget({ kind: 'ok' }, WITHOUT_INTEGRITY, PIN),
      );
      const lock = await readLockfile(repo.root);
      expect(lock?.renderer).toEqual(PIN);

      // A machine whose installed package matches the pin checks clean.
      const check = await runCheck(repo.root, new FakeRenderTarget({ kind: 'ok' }, PIN, PIN));
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('produces a byte-identical lockfile on a machine with a different install', async () => {
    const first = await createTempRepo();
    const second = await createTempRepo();
    try {
      await runGenerate(
        { cwd: first.root, dryRun: false },
        new FakeRenderTarget({ kind: 'ok' }, { ...PIN, integrity: 'sha512-machine-a' }, PIN),
      );
      await runGenerate(
        { cwd: second.root, dryRun: false },
        new FakeRenderTarget({ kind: 'ok' }, WITHOUT_INTEGRITY, PIN),
      );
      expect(await readFile(join(first.root, '.farna/lock.json'), 'utf8')).toBe(
        await readFile(join(second.root, '.farna/lock.json'), 'utf8'),
      );
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it('fails F010 when the recorded identity carries no integrity', async () => {
    const repo = await createTempRepo();
    try {
      await expect(
        runGenerate(
          { cwd: repo.root, dryRun: false },
          new FakeRenderTarget({ kind: 'ok' }, WITHOUT_INTEGRITY, WITHOUT_INTEGRITY),
        ),
      ).rejects.toMatchObject({ code: 'F010_RENDERER_MISMATCH' });
    } finally {
      await repo.cleanup();
    }
  });

  it('fails F010 when the installed identity carries no integrity', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate(
        { cwd: repo.root, dryRun: false },
        new FakeRenderTarget({ kind: 'ok' }, PIN, PIN),
      );
      await expect(
        runCheck(repo.root, new FakeRenderTarget({ kind: 'ok' }, WITHOUT_INTEGRITY, PIN)),
      ).rejects.toMatchObject({ code: 'F010_RENDERER_MISMATCH' });
    } finally {
      await repo.cleanup();
    }
  });

  it('fails F010 when a committed lockfile records no integrity', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const path = join(repo.root, '.farna/lock.json');
      const lock = JSON.parse(await readFile(path, 'utf8')) as {
        renderer: Record<string, unknown>;
      };
      delete lock.renderer['integrity'];
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        path,
        `${JSON.stringify(lock, null, 2)}
`,
        'utf8',
      );
      // A lockfile that cannot tie its bytes to a pinned renderer is an
      // identity failure (F010), never a version-only comparison that passes.
      await expect(runCheck(repo.root, new FakeRenderTarget())).rejects.toMatchObject({
        code: 'F010_RENDERER_MISMATCH',
        subject: '.farna/lock.json',
      });
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
