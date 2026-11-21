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
import {
  LOCKFILE_MAX_BYTES,
  NPM_LOCKFILE_MAX_BYTES,
  PRODUCT_NAME,
} from '../../src/core/constants.js';
import { readLockfile } from '../../src/lock/lockfile.js';
import { readRecordedIntegrity } from '../../src/render/identity.js';
import type { RendererIdentity } from '../../src/render/port.js';
import { rendererIntegrityWarning } from '../../src/render/prepare.js';
import { assertPinned, RENDERER_PIN } from '../../src/render/upstream.js';
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
      // The installed package carries a local integrity, but the lockfile
      // records the build's pin so two verified machines agree byte for byte.
      await runGenerate(
        { cwd: repo.root, dryRun: false },
        new FakeRenderTarget({ kind: 'ok' }, { ...PIN, integrity: 'sha512-machine-local' }, PIN),
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

  it('produces a byte-identical lockfile across verified and unverified installs', async () => {
    const first = await createTempRepo();
    const second = await createTempRepo();
    const third = await createTempRepo();
    try {
      await runGenerate(
        { cwd: first.root, dryRun: false },
        new FakeRenderTarget({ kind: 'ok' }, { ...PIN, integrity: 'sha512-machine-a' }, PIN),
      );
      await runGenerate(
        { cwd: second.root, dryRun: false },
        new FakeRenderTarget({ kind: 'ok' }, { ...PIN, integrity: 'sha512-machine-b' }, PIN),
      );
      const unverified = await runGenerate(
        { cwd: third.root, dryRun: false },
        new FakeRenderTarget({ kind: 'ok' }, WITHOUT_INTEGRITY, PIN),
      );
      expect(unverified.warnings.map((entry) => entry.code)).toContain(W114);
      const verifiedBytes = await readFile(join(first.root, '.farna/lock.json'), 'utf8');
      expect(await readFile(join(second.root, '.farna/lock.json'), 'utf8')).toBe(verifiedBytes);
      // The unverified machine reports W114, but that is runtime evidence and
      // must not change the byte-compared artefact.
      expect(await readFile(join(third.root, '.farna/lock.json'), 'utf8')).toBe(verifiedBytes);
    } finally {
      await first.cleanup();
      await second.cleanup();
      await third.cleanup();
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

  it('warns W114, and checks clean, when the installed identity carries no integrity', async () => {
    const repo = await createTempRepo();
    try {
      // The lockfile carries no W114 (see the test below), so this proves the
      // warning is reported by the command while the bytes still verify.
      await runGenerate(
        { cwd: repo.root, dryRun: false },
        new FakeRenderTarget({ kind: 'ok' }, WITHOUT_INTEGRITY, PIN),
      );
      const check = await runCheck(
        repo.root,
        new FakeRenderTarget({ kind: 'ok' }, WITHOUT_INTEGRITY, PIN),
      );
      // The version still matched, so an unverified integrity is a named gap,
      // not a refusal, and the bytes still verify.
      expect(check.ok).toBe(true);
      expect(check.warnings.map((entry) => entry.code)).toContain(W114);
    } finally {
      await repo.cleanup();
    }
  });

  it('reports W114 from the command but never records it in the lockfile', async () => {
    const repo = await createTempRepo();
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new FakeRenderTarget({ kind: 'ok' }, WITHOUT_INTEGRITY, PIN),
      );
      expect(result.warnings.map((entry) => entry.code)).toContain(W114);
      const lock = await readLockfile(repo.root);
      expect(lock?.warnings.map((entry) => entry.code)).not.toContain(W114);
      expect(lock?.warnings).toHaveLength(0);
      // The pin is still the recorded identity; W114 says this machine could
      // not check it, and that belongs in the report, not the artefact.
      expect(lock?.renderer).toEqual(PIN);
    } finally {
      await repo.cleanup();
    }
  });

  it('checks clean in both directions across a verified and an unverified install', async () => {
    const repo = await createTempRepo();
    try {
      // Generated on a machine that could not verify its install, so a
      // verified machine must not see drift from the missing W114 record.
      await runGenerate(
        { cwd: repo.root, dryRun: false },
        new FakeRenderTarget({ kind: 'ok' }, WITHOUT_INTEGRITY, PIN),
      );
      const verified = await runCheck(repo.root, new FakeRenderTarget({ kind: 'ok' }, PIN, PIN));
      expect(verified.ok).toBe(true);
      expect(verified.drift).toHaveLength(0);
      expect(verified.warnings.map((entry) => entry.code)).not.toContain(W114);
      const unverified = await runCheck(
        repo.root,
        new FakeRenderTarget({ kind: 'ok' }, WITHOUT_INTEGRITY, PIN),
      );
      expect(unverified.ok).toBe(true);
      expect(unverified.drift).toHaveLength(0);
      expect(unverified.warnings.map((entry) => entry.code)).toContain(W114);
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

const W114 = 'W114_RENDERER_INTEGRITY_UNVERIFIED';

function noRecord(name = RENDERER_PIN.name, version = RENDERER_PIN.version): RendererIdentity {
  return { name, version, integrityRecord: { verified: false, reason: 'no-record' } };
}

function noIntegrity(name = RENDERER_PIN.name, version = RENDERER_PIN.version): RendererIdentity {
  return { name, version, integrityRecord: { verified: false, reason: 'no-integrity' } };
}

describe('the renderer identity policy', () => {
  const pinned = { name: RENDERER_PIN.name, version: RENDERER_PIN.version };

  it('accepts a matching version and integrity', () => {
    expect(() => assertPinned({ ...pinned, integrity: RENDERER_PIN.integrity })).not.toThrow();
  });

  it('refuses a version mismatch even when npm recorded no integrity', () => {
    // The version is the enforced half of the policy, so an absent integrity
    // must never let a substituted renderer pass.
    expect(() => assertPinned(noRecord(RENDERER_PIN.name, '9.9.9'))).toThrowError(
      expect.objectContaining({ code: 'F010_RENDERER_MISMATCH' }),
    );
  });

  it('refuses a recorded integrity that differs from the pin', () => {
    const installed: RendererIdentity = {
      ...pinned,
      integrity: 'sha512-somebody-elses-tarball',
    };
    expect(() => assertPinned(installed)).toThrowError(
      expect.objectContaining({ code: 'F010_RENDERER_MISMATCH' }),
    );
  });

  it('does not substitute the pin for a missing integrity, and names it with W114', () => {
    // The old fallback made a global install look verified. It must not: the
    // version is still enforced, and the unverified integrity is reported.
    const installed = noRecord();
    expect(installed.integrity).toBeUndefined();
    expect(() => assertPinned(installed)).not.toThrow();
    const entry = rendererIntegrityWarning(installed);
    expect(entry).toMatchObject({ code: W114, severity: 'medium' });
    expect(entry?.message).toContain('no npm lock record');
    expect(entry?.message).toContain('pinned version is still enforced');
  });

  it('names an entry without a string integrity with W114 and its reason', () => {
    const entry = rendererIntegrityWarning(noIntegrity());
    expect(entry).toMatchObject({ code: W114, severity: 'medium' });
    expect(entry?.message).toContain('npm lock record');
    expect(entry?.message).toContain('has no integrity');
  });

  it('does not warn when the installed integrity matches the pin', () => {
    expect(
      rendererIntegrityWarning({ ...pinned, integrity: RENDERER_PIN.integrity }),
    ).toBeUndefined();
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
      expect(readRecordedIntegrity(packageDirOf(root), 'rulesync')).toEqual({
        verified: true,
        integrity: 'sha512-small',
      });
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
      expect(recorded).toEqual({ verified: true, integrity: RENDERER_PIN.integrity });
      if (!recorded.verified) {
        throw new Error('expected the large record to be read');
      }
      expect(() =>
        assertPinned({
          name: RENDERER_PIN.name,
          version: RENDERER_PIN.version,
          integrity: recorded.integrity,
        }),
      ).not.toThrow();
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
      expect(recorded).toEqual({ verified: true, integrity: 'sha512-DIFFERENT-NOT-THE-PIN' });
      if (!recorded.verified) {
        throw new Error('expected the large record to be read');
      }
      expect(() =>
        assertPinned({
          name: RENDERER_PIN.name,
          version: RENDERER_PIN.version,
          integrity: recorded.integrity,
        }),
      ).toThrowError(expect.objectContaining({ code: 'F010_RENDERER_MISMATCH' }));
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
    // The install root is the top of the renderer's node_modules chain. A
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
      expect(readRecordedIntegrity(packageDir, 'rulesync')).toEqual({
        verified: false,
        reason: 'no-record',
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('ignores a parent lockfile even when the parent owns a node_modules directory', async () => {
    // Reaching a nested install must not turn into climbing above the project.
    // A parent monorepo that happens to own a node_modules directory is still
    // outside the renderer's chain, so its record is never read.
    const parent = await mkdtemp(join(tmpdir(), 'fbs-integrity-mono-'));
    const root = join(parent, 'project');
    const packageDir = packageDirOf(root);
    try {
      await mkdir(packageDir, { recursive: true });
      await mkdir(join(parent, 'node_modules'), { recursive: true });
      await writeFile(
        join(parent, 'package-lock.json'),
        JSON.stringify({
          packages: { 'node_modules/rulesync': { integrity: 'sha512-PARENT-MONOREPO' } },
        }),
        'utf8',
      );
      expect(readRecordedIntegrity(packageDir, 'rulesync')).toEqual({
        verified: false,
        reason: 'no-record',
      });
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

  it.skipIf(isRoot)(
    'fails F010 for an unreadable hidden record even when the lockfile is readable',
    async () => {
      // Both supported records are read before the search, so a hidden record
      // that exists but cannot be read is a refusal, never silently skipped in
      // favour of the readable lockfile beside it.
      const root = await layout(
        JSON.stringify({ packages: { 'node_modules/rulesync': { integrity: 'sha512-small' } } }),
      );
      const hidden = join(root, 'node_modules', '.package-lock.json');
      try {
        await writeFile(hidden, JSON.stringify({ packages: {} }), 'utf8');
        await chmod(hidden, 0o000);
        expect(() => readRecordedIntegrity(packageDirOf(root), 'rulesync')).toThrowError(
          expect.objectContaining({ code: 'F010_RENDERER_MISMATCH', subject: hidden }),
        );
      } finally {
        await chmod(hidden, 0o600);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(isRoot)(
    'fails F010 for an unreadable lockfile even when the hidden record verified',
    async () => {
      // A present record that cannot be read is refused in either supported
      // path. Returning as soon as the hidden record supplied an integrity
      // would silently skip the unreadable lockfile beside it.
      const record = JSON.stringify({
        packages: { 'node_modules/rulesync': { integrity: 'sha512-small' } },
      });
      const root = await layout(record);
      const lock = join(root, 'package-lock.json');
      const hidden = join(root, 'node_modules', '.package-lock.json');
      try {
        await writeFile(hidden, record, 'utf8');
        await chmod(lock, 0o000);
        expect(() => readRecordedIntegrity(packageDirOf(root), 'rulesync')).toThrowError(
          expect.objectContaining({ code: 'F010_RENDERER_MISMATCH', subject: lock }),
        );
      } finally {
        await chmod(lock, 0o600);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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

  it('returns a structured no-record result when no lock record exists', async () => {
    // The genuine global-install case: there is no record at all. The version
    // is still checked and the gap is named by W114, never silently passed.
    const root = await mkdtemp(join(tmpdir(), 'fbs-integrity-none-'));
    const packageDir = packageDirOf(root);
    try {
      await mkdir(packageDir, { recursive: true });
      const record = readRecordedIntegrity(packageDir, 'rulesync');
      expect(record).toEqual({ verified: false, reason: 'no-record' });
      const installed: RendererIdentity = {
        name: RENDERER_PIN.name,
        version: RENDERER_PIN.version,
        integrityRecord: record,
      };
      expect(() => assertPinned(installed)).not.toThrow();
      expect(rendererIntegrityWarning(installed)).toMatchObject({ code: W114 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('distinguishes a record whose renderer entry has no string integrity', async () => {
    const root = await layout(
      JSON.stringify({
        packages: { 'node_modules/rulesync': { version: RENDERER_PIN.version } },
      }),
    );
    try {
      const record = readRecordedIntegrity(packageDirOf(root), 'rulesync');
      // The reference to the renderer exists, so this is not "no record": the
      // warning must name the missing integrity instead.
      expect(record).toEqual({ verified: false, reason: 'no-integrity' });
      const entry = rendererIntegrityWarning({
        name: RENDERER_PIN.name,
        version: RENDERER_PIN.version,
        integrityRecord: record,
      });
      expect(entry).toMatchObject({ code: W114 });
      expect(entry?.message).toContain('has no integrity');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('a nested install layout', () => {
  // `npm install --install-strategy=nested` puts the renderer under the package
  // that depends on it, and records it under that same nested key. Reading only
  // `node_modules/<name>` made a present record look absent, so `generate`
  // exited 0 with no integrity recorded.
  const NESTED_KEY = `node_modules/${PRODUCT_NAME}/node_modules/${RENDERER_PIN.name}`;

  type NestedLayout = { root: string; packageDir: string };

  async function nestedLayout(): Promise<NestedLayout> {
    const root = await mkdtemp(join(tmpdir(), 'fbs-nested-'));
    const packageDir = join(root, 'node_modules', PRODUCT_NAME, 'node_modules', RENDERER_PIN.name);
    await mkdir(packageDir, { recursive: true });
    return { root, packageDir };
  }

  async function writeRecord(path: string, entries: Record<string, unknown>): Promise<void> {
    await writeFile(path, JSON.stringify({ packages: entries }), 'utf8');
  }

  function pinned(integrity: string): RendererIdentity {
    return { name: RENDERER_PIN.name, version: RENDERER_PIN.version, integrity };
  }

  it('reads the nested entry from the project lockfile instead of falling back to the pin', async () => {
    const { root, packageDir } = await nestedLayout();
    try {
      await writeRecord(join(root, 'package-lock.json'), {
        [NESTED_KEY]: { integrity: 'sha512-from-the-nested-record' },
      });
      expect(readRecordedIntegrity(packageDir, RENDERER_PIN.name)).toEqual({
        verified: true,
        integrity: 'sha512-from-the-nested-record',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads the nested entry from the hidden install-root record', async () => {
    const { root, packageDir } = await nestedLayout();
    try {
      await writeRecord(join(root, 'node_modules', '.package-lock.json'), {
        [NESTED_KEY]: { integrity: 'sha512-from-the-hidden-record' },
      });
      expect(readRecordedIntegrity(packageDir, RENDERER_PIN.name)).toEqual({
        verified: true,
        integrity: 'sha512-from-the-hidden-record',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prefers the entry nested under our own package over a hoisted one', async () => {
    const { root, packageDir } = await nestedLayout();
    try {
      await writeRecord(join(root, 'package-lock.json'), {
        'node_modules/rulesync': { integrity: 'sha512-hoisted-copy' },
        [NESTED_KEY]: { integrity: 'sha512-the-copy-we-import' },
      });
      expect(readRecordedIntegrity(packageDir, RENDERER_PIN.name)).toEqual({
        verified: true,
        integrity: 'sha512-the-copy-we-import',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails F010 for a nested entry whose integrity differs from the pin', async () => {
    const { root, packageDir } = await nestedLayout();
    try {
      await writeRecord(join(root, 'package-lock.json'), {
        [NESTED_KEY]: { integrity: 'sha512-DIFFERENT-NOT-THE-PIN' },
      });
      const recorded = readRecordedIntegrity(packageDir, RENDERER_PIN.name);
      expect(recorded).toEqual({ verified: true, integrity: 'sha512-DIFFERENT-NOT-THE-PIN' });
      if (!recorded.verified) {
        throw new Error('expected the nested record to be read');
      }
      // A nested install is a real record: its integrity is compared, never
      // replaced by the pin.
      expect(() => assertPinned(pinned(recorded.integrity))).toThrowError(
        expect.objectContaining({ code: 'F010_RENDERER_MISMATCH' }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still reads a hoisted entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fbs-hoisted-'));
    const packageDir = join(root, 'node_modules', RENDERER_PIN.name);
    try {
      await mkdir(packageDir, { recursive: true });
      await writeRecord(join(root, 'package-lock.json'), {
        'node_modules/rulesync': { integrity: 'sha512-hoisted-entry' },
      });
      expect(readRecordedIntegrity(packageDir, RENDERER_PIN.name)).toEqual({
        verified: true,
        integrity: 'sha512-hoisted-entry',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds the renderer nested under any package, not only ours', async () => {
    const { root, packageDir } = await nestedLayout();
    try {
      await writeRecord(join(root, 'package-lock.json'), {
        'node_modules/some-other-package/node_modules/rulesync': {
          integrity: 'sha512-nested-elsewhere',
        },
      });
      expect(readRecordedIntegrity(packageDir, RENDERER_PIN.name)).toEqual({
        verified: true,
        integrity: 'sha512-nested-elsewhere',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('names a nested install with no record anywhere with W114', async () => {
    // The genuine global-install case: the install tree exists but no npm lock
    // record does. The version is still checked; the gap is named, not passed.
    const { root, packageDir } = await nestedLayout();
    try {
      const record = readRecordedIntegrity(packageDir, RENDERER_PIN.name);
      expect(record).toEqual({ verified: false, reason: 'no-record' });
      const installed: RendererIdentity = {
        name: RENDERER_PIN.name,
        version: RENDERER_PIN.version,
        integrityRecord: record,
      };
      expect(() => assertPinned(installed)).not.toThrow();
      expect(rendererIntegrityWarning(installed)).toMatchObject({ code: W114 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('a hoisted workspace install', () => {
  // A plain npm workspace hoists the renderer to `<ws>/node_modules/rulesync`,
  // so the workspace root IS the install root and its two records are read.
  // Only a workspace root above the install root is skipped (next suite).
  type HoistedLayout = { ws: string; packageDir: string };

  async function hoistedLayout(): Promise<HoistedLayout> {
    const ws = await mkdtemp(join(tmpdir(), 'fbs-hoisted-workspace-'));
    const packageDir = join(ws, 'node_modules', RENDERER_PIN.name);
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(ws, 'package.json'),
      JSON.stringify({ name: 'workspace-root', private: true, workspaces: ['packages/*'] }),
      'utf8',
    );
    return { ws, packageDir };
  }

  async function writeRecord(path: string, entries: Record<string, unknown>): Promise<void> {
    await writeFile(path, JSON.stringify({ packages: entries }), 'utf8');
  }

  function installedFrom(record: ReturnType<typeof readRecordedIntegrity>): RendererIdentity {
    return { name: RENDERER_PIN.name, version: RENDERER_PIN.version, integrityRecord: record };
  }

  it('reads a hoisted renderer from the workspace root lockfile and does not warn', async () => {
    const { ws, packageDir } = await hoistedLayout();
    try {
      await writeRecord(join(ws, 'package-lock.json'), {
        [`node_modules/${RENDERER_PIN.name}`]: { integrity: RENDERER_PIN.integrity },
      });
      const record = readRecordedIntegrity(packageDir, RENDERER_PIN.name);
      expect(record).toEqual({ verified: true, integrity: RENDERER_PIN.integrity });
      const installed = installedFrom(record);
      // A matching integrity is a clean pass: no W114, and the pin check holds.
      expect(rendererIntegrityWarning(installed)).toBeUndefined();
      expect(() => assertPinned(installed)).not.toThrow();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('reads a hoisted renderer from the workspace root hidden record', async () => {
    const { ws, packageDir } = await hoistedLayout();
    try {
      await writeRecord(join(ws, 'node_modules', '.package-lock.json'), {
        [`node_modules/${RENDERER_PIN.name}`]: { integrity: RENDERER_PIN.integrity },
      });
      const record = readRecordedIntegrity(packageDir, RENDERER_PIN.name);
      expect(record).toEqual({ verified: true, integrity: RENDERER_PIN.integrity });
      expect(rendererIntegrityWarning(installedFrom(record))).toBeUndefined();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('refuses a hoisted workspace record whose integrity differs from the pin', async () => {
    const { ws, packageDir } = await hoistedLayout();
    try {
      await writeRecord(join(ws, 'package-lock.json'), {
        [`node_modules/${RENDERER_PIN.name}`]: { integrity: 'sha512-DIFFERENT-NOT-THE-PIN' },
      });
      const record = readRecordedIntegrity(packageDir, RENDERER_PIN.name);
      expect(record).toEqual({ verified: true, integrity: 'sha512-DIFFERENT-NOT-THE-PIN' });
      expect(() => assertPinned(installedFrom(record))).toThrowError(
        expect.objectContaining({ code: 'F010_RENDERER_MISMATCH', exitCode: 5 }),
      );
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('ancestor and workspace layouts that are not read', () => {
  // The only two supported records sit at the install root. A workspace root
  // ABOVE the install root (a member with its own copy), a parent monorepo and
  // the directory directly above a member's install root record a different
  // copy of the renderer (or none), so reading them refused a healthy install
  // with a foreign integrity or claimed a verification that was never made.
  // Those layouts yield W114 and are never opened.
  const MEMBER = 'packages/foo';
  const WORKSPACE_KEY = `${MEMBER}/node_modules/${RENDERER_PIN.name}`;

  type WorkspaceLayout = { root: string; packageDir: string };

  async function workspaceLayout(): Promise<WorkspaceLayout> {
    const root = await mkdtemp(join(tmpdir(), 'fbs-workspace-'));
    const packageDir = join(root, MEMBER, 'node_modules', RENDERER_PIN.name);
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'monorepo', private: true, workspaces: ['packages/*'] }),
      'utf8',
    );
    return { root, packageDir };
  }

  async function writeRecord(path: string, entries: Record<string, unknown>): Promise<void> {
    await writeFile(path, JSON.stringify({ packages: entries }), 'utf8');
  }

  function installedFrom(record: ReturnType<typeof readRecordedIntegrity>): RendererIdentity {
    return { name: RENDERER_PIN.name, version: RENDERER_PIN.version, integrityRecord: record };
  }

  it('yields W114 from a workspace root above the install root', async () => {
    // The differing integrity proves the file was not opened: reading it would
    // have refused (F010) instead of reporting the gap.
    const { root, packageDir } = await workspaceLayout();
    try {
      await writeRecord(join(root, 'package-lock.json'), {
        [WORKSPACE_KEY]: { integrity: 'sha512-DIFFERENT-NOT-THE-PIN' },
      });
      const record = readRecordedIntegrity(packageDir, RENDERER_PIN.name);
      expect(record).toEqual({ verified: false, reason: 'no-record' });
      const installed = installedFrom(record);
      // The version is still enforced; only the integrity is unverified.
      expect(() => assertPinned(installed)).not.toThrow();
      expect(rendererIntegrityWarning(installed)).toMatchObject({ code: W114 });
      expect(() => assertPinned({ ...installed, version: '9.9.9' })).toThrowError(
        expect.objectContaining({ code: 'F010_RENDERER_MISMATCH' }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('yields W114 from an above-install-root hidden record', async () => {
    const { root, packageDir } = await workspaceLayout();
    try {
      await mkdir(join(root, 'node_modules'), { recursive: true });
      await writeRecord(join(root, 'node_modules', '.package-lock.json'), {
        [WORKSPACE_KEY]: { integrity: RENDERER_PIN.integrity ?? 'sha512-pin' },
      });
      const record = readRecordedIntegrity(packageDir, RENDERER_PIN.name);
      expect(record).toEqual({ verified: false, reason: 'no-record' });
      expect(rendererIntegrityWarning(installedFrom(record))).toMatchObject({ code: W114 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not verify from the directory directly above the install root', async () => {
    // The removed direct-parent lookup read `<parent>/package-lock.json` and
    // accepted an entry keyed by the project's relative path. That record
    // describes the parent's tree, not this install, so it is not read.
    const parent = await mkdtemp(join(tmpdir(), 'fbs-parent-record-'));
    const root = join(parent, 'project');
    const packageDir = join(root, 'node_modules', RENDERER_PIN.name);
    try {
      await mkdir(packageDir, { recursive: true });
      await writeRecord(join(parent, 'package-lock.json'), {
        [`project/node_modules/${RENDERER_PIN.name}`]: { integrity: 'sha512-PARENT-DIRECT' },
      });
      expect(readRecordedIntegrity(packageDir, RENDERER_PIN.name)).toEqual({
        verified: false,
        reason: 'no-record',
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('does not take another workspace member renderer entry', async () => {
    // The workspace root records every member. Another member's renderer is a
    // different copy, so reading it would compare this install against a
    // foreign integrity and refuse a healthy tree.
    const { root, packageDir } = await workspaceLayout();
    try {
      await writeRecord(join(root, 'package-lock.json'), {
        [`packages/other/node_modules/${RENDERER_PIN.name}`]: { integrity: 'sha512-other-member' },
      });
      expect(readRecordedIntegrity(packageDir, RENDERER_PIN.name)).toEqual({
        verified: false,
        reason: 'no-record',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops at the workspace root and never reads a parent monorepo record', async () => {
    // A different install above the real workspace root must never supply the
    // integrity: its record describes its own tree, not this one.
    const outer = await mkdtemp(join(tmpdir(), 'fbs-workspace-outer-'));
    const root = join(outer, 'monorepo');
    const packageDir = join(root, MEMBER, 'node_modules', RENDERER_PIN.name);
    try {
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'workspace', private: true, workspaces: ['packages/*'] }),
        'utf8',
      );
      await writeFile(
        join(outer, 'package.json'),
        JSON.stringify({ name: 'outer', private: true, workspaces: ['monorepo'] }),
        'utf8',
      );
      await writeRecord(join(outer, 'package-lock.json'), {
        [`monorepo/${MEMBER}/node_modules/${RENDERER_PIN.name}`]: { integrity: 'sha512-outer' },
      });
      expect(readRecordedIntegrity(packageDir, RENDERER_PIN.name)).toEqual({
        verified: false,
        reason: 'no-record',
      });
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });
});

describe('install layouts that cannot supply an integrity', () => {
  async function emptyPackage(packageDir: string): Promise<string> {
    await mkdir(packageDir, { recursive: true });
    return packageDir;
  }

  it('names a scoped install with no record with W114 instead of passing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fbs-scoped-'));
    try {
      const packageDir = await emptyPackage(join(root, 'node_modules', '@acme', 'renderer'));
      const record = readRecordedIntegrity(packageDir, '@acme/renderer');
      expect(record).toEqual({ verified: false, reason: 'no-record' });
      const entry = rendererIntegrityWarning({
        name: '@acme/renderer',
        version: '1.2.3',
        integrityRecord: record,
      });
      expect(entry).toMatchObject({ code: W114 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('names a linked install outside node_modules with no record with W114', async () => {
    // `npm link` / `file:` installs place the package anywhere on disk, with no
    // npm-owned lock record beside it. That is a named gap, not a pass.
    const root = await mkdtemp(join(tmpdir(), 'fbs-linked-'));
    try {
      const packageDir = await emptyPackage(join(root, 'vendor', 'renderer'));
      const record = readRecordedIntegrity(packageDir, 'renderer');
      expect(record).toEqual({ verified: false, reason: 'no-record' });
      const entry = rendererIntegrityWarning({
        name: 'renderer',
        version: '1.2.3',
        integrityRecord: record,
      });
      expect(entry).toMatchObject({ code: W114 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads a scoped renderer entry when its key is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fbs-scoped-found-'));
    try {
      const packageDir = await emptyPackage(join(root, 'node_modules', '@acme', 'renderer'));
      await writeFile(
        join(root, 'package-lock.json'),
        JSON.stringify({
          packages: { 'node_modules/@acme/renderer': { integrity: 'sha512-scoped-entry' } },
        }),
        'utf8',
      );
      expect(readRecordedIntegrity(packageDir, '@acme/renderer')).toEqual({
        verified: true,
        integrity: 'sha512-scoped-entry',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('source-derived warnings in the lockfile', () => {
  it('keeps the W106 and W113 warnings the source produced in .farna/lock.json', async () => {
    // The lockfile must describe the source it compiled. A regression that
    // writes an empty warnings array would leave both checks below empty, so
    // the assertion names the codes rather than the count.
    const repo = await createTempRepo('composed');
    try {
      await runGenerate(
        { cwd: repo.root, dryRun: false },
        new FakeRenderTarget({ kind: 'ok' }, PIN, PIN),
      );
      const lock = await readLockfile(repo.root);
      const codes = lock?.warnings.map((entry) => entry.code) ?? [];
      expect(codes).toContain('W106_DENY_WINS');
      expect(codes).toContain('W113_ALLOW_LIST_NARROWS');
    } finally {
      await repo.cleanup();
    }
  });
});
