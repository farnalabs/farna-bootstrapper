import { execFileSync } from 'node:child_process';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { LOCKFILE_MAX_BYTES, NPM_LOCKFILE_MAX_BYTES } from '../../src/core/constants.js';
import { readLockfile } from '../../src/lock/lockfile.js';
import { readRecordedIntegrity } from '../../src/render/identity.js';
import type { RendererIdentity } from '../../src/render/port.js';
import { assertPinned, RENDERER_PIN, resolvePinnedIdentity } from '../../src/render/upstream.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createTempRepo, hashTree } from '../support/temp-repo.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const skipSymlinks = process.platform === 'win32';

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

describe('the pinned renderer integrity fallback', () => {
  it('accepts a global-style install with no npm integrity, using the compile-time pin', () => {
    // A global install writes no npm lockfile. The pin stands in for the
    // missing integrity; the version is still checked.
    const resolved = resolvePinnedIdentity({
      name: RENDERER_PIN.name,
      version: RENDERER_PIN.version,
    });
    expect(resolved.integrity).toBe(RENDERER_PIN.integrity);
    expect(() => assertPinned(resolved)).not.toThrow();
  });

  it('still refuses a version mismatch when npm recorded no integrity', () => {
    const resolved = resolvePinnedIdentity({ name: RENDERER_PIN.name, version: '9.9.9' });
    expect(resolved.integrity).toBeUndefined();
    expect(() => assertPinned(resolved)).toThrowError(
      expect.objectContaining({ code: 'F010_RENDERER_MISMATCH' }),
    );
  });

  it('refuses a recorded integrity that differs from the pin', () => {
    const installed: RendererIdentity = {
      name: RENDERER_PIN.name,
      version: RENDERER_PIN.version,
      integrity: 'sha512-somebody-elses-tarball',
    };
    const resolved = resolvePinnedIdentity(installed);
    // A recorded integrity is never overwritten with the pin.
    expect(resolved.integrity).toBe('sha512-somebody-elses-tarball');
    expect(() => assertPinned(resolved)).toThrowError(
      expect.objectContaining({ code: 'F010_RENDERER_MISMATCH' }),
    );
  });
});

describe('the bounded npm integrity read', () => {
  async function layout(lockfile: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'fbs-integrity-'));
    const packageDir = join(root, 'node_modules', 'rulesync');
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(root, 'package-lock.json'), lockfile, 'utf8');
    return root;
  }

  function packageDirOf(root: string): string {
    return join(root, 'node_modules', 'rulesync');
  }

  /** A valid npm lock record whose padding pushes it past 5 MiB. */
  function largeRecord(integrity: string): string {
    return JSON.stringify({
      packages: { 'node_modules/rulesync': { integrity } },
      padding: 'x'.repeat(5 * 1024 * 1024),
    });
  }

  it('reads the integrity from an ancestor project lockfile', async () => {
    const root = await layout(
      JSON.stringify({ packages: { 'node_modules/rulesync': { integrity: 'sha512-small' } } }),
    );
    try {
      expect(readRecordedIntegrity(packageDirOf(root), 'rulesync')).toBe('sha512-small');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads a 5 MiB record whose integrity matches the pin, and it passes', async () => {
    // npm's record scales with the dependency tree. A real monorepo lockfile
    // is over the 4 MiB derived-lockfile bound, so applying that bound here
    // used to refuse a perfectly good install.
    const pinIntegrity = RENDERER_PIN.integrity;
    if (pinIntegrity === undefined) {
      throw new Error('the renderer pin must carry an integrity');
    }
    const record = largeRecord(pinIntegrity);
    expect(Buffer.byteLength(record)).toBeGreaterThan(LOCKFILE_MAX_BYTES);
    expect(Buffer.byteLength(record)).toBeLessThan(NPM_LOCKFILE_MAX_BYTES);
    const root = await layout(record);
    try {
      const recorded = readRecordedIntegrity(packageDirOf(root), RENDERER_PIN.name);
      expect(recorded).toBe(RENDERER_PIN.integrity);
      if (recorded === undefined) {
        throw new Error('expected the large record to be read');
      }
      const resolved = resolvePinnedIdentity({
        name: RENDERER_PIN.name,
        version: RENDERER_PIN.version,
        integrity: recorded,
      });
      expect(() => assertPinned(resolved)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails F010 for a 5 MiB record whose integrity differs from the pin', async () => {
    const record = largeRecord('sha512-DIFFERENT-NOT-THE-PIN');
    expect(Buffer.byteLength(record)).toBeGreaterThan(LOCKFILE_MAX_BYTES);
    const root = await layout(record);
    try {
      const recorded = readRecordedIntegrity(packageDirOf(root), RENDERER_PIN.name);
      expect(recorded).toBe('sha512-DIFFERENT-NOT-THE-PIN');
      if (recorded === undefined) {
        throw new Error('expected the large record to be read');
      }
      const resolved = resolvePinnedIdentity({
        name: RENDERER_PIN.name,
        version: RENDERER_PIN.version,
        integrity: recorded,
      });
      expect(() => assertPinned(resolved)).toThrowError(
        expect.objectContaining({ code: 'F010_RENDERER_MISMATCH' }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses an npm record above the npm bound instead of falling back to the pin', async () => {
    // The record is PRESENT, so it must be refused: skipping it would turn a
    // differing integrity into a pass through the compile-time pin. Only a
    // missing record may fall back (see the no-record test below).
    const oversized = JSON.stringify({
      packages: { 'node_modules/rulesync': { integrity: 'sha512-DIFFERENT-NOT-THE-PIN' } },
      padding: 'x'.repeat(NPM_LOCKFILE_MAX_BYTES),
    });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(NPM_LOCKFILE_MAX_BYTES);
    const root = await layout(oversized);
    try {
      const packageDir = packageDirOf(root);
      let refusal: unknown;
      let message = '';
      try {
        readRecordedIntegrity(packageDir, 'rulesync');
      } catch (error) {
        refusal = error;
        message = error instanceof Error ? error.message : '';
      }
      expect(refusal).toMatchObject({
        code: 'F010_RENDERER_MISMATCH',
        exitCode: 5,
        subject: join(root, 'package-lock.json'),
      });
      expect(message).toContain(`${Buffer.byteLength(oversized)} bytes`);
      expect(message).toContain(`${NPM_LOCKFILE_MAX_BYTES}-byte bound`);
      expect(message).toContain('npm lock record');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores an unrelated parent lockfile above the install root', async () => {
    // The nearest ancestor owning node_modules is the install root. A
    // package-lock.json above it describes a different install and must never
    // be read, or a healthy project could be refused by an unrelated record.
    const parent = await mkdtemp(join(tmpdir(), 'fbs-integrity-parent-'));
    const root = join(parent, 'project');
    const packageDir = packageDirOf(root);
    try {
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        join(parent, 'package-lock.json'),
        JSON.stringify({
          packages: { 'node_modules/rulesync': { integrity: 'sha512-PARENT-UNRELATED' } },
        }),
        'utf8',
      );
      expect(readRecordedIntegrity(packageDir, 'rulesync')).toBeUndefined();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('fails F010 for a symlinked lock record instead of following it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fbs-integrity-link-'));
    const packageDir = packageDirOf(root);
    const target = join(root, 'elsewhere.json');
    try {
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        target,
        JSON.stringify({
          packages: { 'node_modules/rulesync': { integrity: RENDERER_PIN.integrity } },
        }),
        'utf8',
      );
      await symlink(target, join(root, 'package-lock.json'));
      expect(() => readRecordedIntegrity(packageDir, 'rulesync')).toThrowError(
        expect.objectContaining({
          code: 'F010_RENDERER_MISMATCH',
          subject: join(root, 'package-lock.json'),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(skipSymlinks)('fails F010 for a FIFO lock record and does not hang', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fbs-integrity-fifo-'));
    const packageDir = packageDirOf(root);
    try {
      await mkdir(packageDir, { recursive: true });
      execFileSync('mkfifo', [join(root, 'package-lock.json')]);
      expect(() => readRecordedIntegrity(packageDir, 'rulesync')).toThrowError(
        expect.objectContaining({
          code: 'F010_RENDERER_MISMATCH',
          subject: join(root, 'package-lock.json'),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(isRoot)('fails F010 for a lock record that cannot be read (EACCES)', async () => {
    const root = await layout(
      JSON.stringify({ packages: { 'node_modules/rulesync': { integrity: 'sha512-small' } } }),
    );
    const lock = join(root, 'package-lock.json');
    try {
      await chmod(lock, 0o000);
      expect(() => readRecordedIntegrity(packageDirOf(root), 'rulesync')).toThrowError(
        expect.objectContaining({ code: 'F010_RENDERER_MISMATCH', subject: lock }),
      );
    } finally {
      await chmod(lock, 0o600);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails F010 for a lock record that is not valid JSON', async () => {
    const root = await layout('{ this is not json');
    try {
      expect(() => readRecordedIntegrity(packageDirOf(root), 'rulesync')).toThrowError(
        expect.objectContaining({
          code: 'F010_RENDERER_MISMATCH',
          subject: join(root, 'package-lock.json'),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails F010 for a lock record that is not a JSON object', async () => {
    const root = await layout('[]');
    try {
      expect(() => readRecordedIntegrity(packageDirOf(root), 'rulesync')).toThrowError(
        expect.objectContaining({
          code: 'F010_RENDERER_MISMATCH',
          subject: join(root, 'package-lock.json'),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns no integrity when no lock record exists, so the pin stands in', async () => {
    // The genuine global-install case: there is no record at all. This is the
    // only fallback the pin may cover; an existing-but-unreadable record is
    // refused (above).
    const root = await mkdtemp(join(tmpdir(), 'fbs-integrity-none-'));
    const packageDir = packageDirOf(root);
    try {
      await mkdir(packageDir, { recursive: true });
      expect(readRecordedIntegrity(packageDir, 'rulesync')).toBeUndefined();
      const resolved = resolvePinnedIdentity({
        name: RENDERER_PIN.name,
        version: RENDERER_PIN.version,
      });
      expect(resolved.integrity).toBe(RENDERER_PIN.integrity);
      expect(() => assertPinned(resolved)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
