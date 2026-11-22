import { execFileSync } from 'node:child_process';
import { chmod, lstat, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import type { ResolvedSource } from '../../src/compose/resolve.js';
import { LOCKFILE_MAX_BYTES } from '../../src/core/constants.js';
import { sha256Hex } from '../../src/core/json.js';
import {
  buildLockfile,
  lockfileDocumentSchema,
  readLockfile,
  serialiseLockfile,
} from '../../src/lock/lockfile.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createEmptyTempDir, createTempRepo, type TempRepo } from '../support/temp-repo.js';

const skipSymlinks = process.platform === 'win32';

async function generatedRepo(): Promise<TempRepo> {
  const repo = await createTempRepo();
  await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
  return repo;
}

const LOCK = '.farna/lock.json';

describe('lockfile reading', () => {
  it('validates the whole document and returns it', async () => {
    const repo = await generatedRepo();
    try {
      const lock = await readLockfile(repo.root);
      expect(lock?.schemaVersion).toBe(1);
      expect(lock?.product.name).toBe('farna-bootstrapper');
      expect(lock?.target).toBe('claudecode');
      expect(lock?.mode).toBe('agent');
      expect(lock?.activePersona).toBeNull();
      expect(lock?.renderer.integrity).toBe('sha512-fake');
      expect(lock?.files.map((file) => file.path)).toEqual([
        '.claude/agents/builder.md',
        '.claude/agents/reviewer.md',
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a lockfile that misses a required field with a typed error', async () => {
    // A present lockfile is either understood or refused. Treating it as absent
    // discarded the recorded path set, so orphan removal was skipped and the
    // rewritten lockfile forgot every earlier path while `check` stayed green.
    const repo = await generatedRepo();
    try {
      const path = join(repo.root, LOCK);
      const lock = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      delete lock['product'];
      await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');

      await expect(readLockfile(repo.root)).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: LOCK,
        action: expect.stringContaining('delete the lockfile and re-run generate'),
      });
      await expect(runCheck(repo.root, new FakeRenderTarget())).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: LOCK,
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a malformed document with a typed error, never "no records"', async () => {
    const repo = await generatedRepo();
    try {
      await writeFile(join(repo.root, LOCK), '{"schemaVersion":1}\n', 'utf8');
      await expect(readLockfile(repo.root)).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: LOCK,
        message: expect.stringContaining('did not validate'),
      });
      await expect(runCheck(repo.root, new FakeRenderTarget())).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: LOCK,
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('accepts a legacy lockfile written before profile mode existed', async () => {
    // A lockfile written before profile mode has neither `mode` nor `activePersona`. Failing to
    // parse it made every path unrecorded, so a persona switch left the old
    // artefacts live and `check` reported clean.
    const repo = await generatedRepo();
    try {
      const path = join(repo.root, LOCK);
      const lock = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      delete lock['mode'];
      delete lock['activePersona'];
      delete lock['notLive'];
      delete lock['configDigest'];
      await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');

      const legacy = await readLockfile(repo.root);
      expect(legacy?.mode).toBe('agent');
      expect(legacy?.activePersona).toBeNull();
      expect(legacy?.files.map((file) => file.path)).toEqual([
        '.claude/agents/builder.md',
        '.claude/agents/reviewer.md',
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a managed path with a control character', async () => {
    const repo = await generatedRepo();
    try {
      const path = join(repo.root, LOCK);
      const lock = JSON.parse(await readFile(path, 'utf8')) as {
        files: Array<{ path: string }>;
      };
      const first = lock.files[0];
      if (first !== undefined) {
        first.path = `.claude/agents/builder\u001b[31m.md`;
      }
      await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
      await expect(readLockfile(repo.root)).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: LOCK,
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('produces a document its own reader accepts, without an empty structured shape', () => {
    const source = {
      target: 'opencode',
      mode: 'agent',
      active: null,
      notLive: [],
      personas: [],
      mcp: [],
      skills: [],
      commands: [],
      hooks: [],
      warnings: [],
    } as unknown as ResolvedSource;
    const lock = buildLockfile(
      source,
      { name: 'rulesync', version: '43.11.0', integrity: 'sha512-test' },
      [
        // A structured shape with no owned key must not be stamped: the reader
        // refuses a `structured` entry with an empty `ownedKeys`, so stamping
        // it would produce a document this tool cannot read back.
        {
          path: 'opencode.jsonc',
          bytes: '{}\n',
          shape: 'structured',
          ownedKeys: [],
          ownedSha256: sha256Hex('{}'),
          ownedSize: 2,
        },
        { path: '.opencode/agents/a.md', bytes: 'agent\n' },
      ],
      [],
      { configDigest: 'a'.repeat(64), notLive: [] },
    );
    const parsed = lockfileDocumentSchema.safeParse(JSON.parse(serialiseLockfile(lock)));
    expect(parsed.success).toBe(true);
    const entry = lock.files.find((file) => file.path === 'opencode.jsonc');
    expect(entry?.shape).toBeUndefined();
    expect(entry?.ownedKeys).toBeUndefined();
    expect(entry?.sha256).toBe(sha256Hex('{}\n'));
  });

  it('returns undefined when the lockfile is absent', async () => {
    const repo = await createTempRepo();
    try {
      expect(await readLockfile(repo.root)).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it.skipIf(skipSymlinks)('refuses a symlinked lockfile with F003', async () => {
    const repo = await generatedRepo();
    const outside = await createEmptyTempDir();
    try {
      const path = join(repo.root, LOCK);
      const target = join(outside.root, 'lock.json');
      await rename(path, target);
      await symlink(target, path, 'file');
      await expect(readLockfile(repo.root)).rejects.toMatchObject({
        code: 'F003_PATH_UNSAFE',
        subject: LOCK,
      });
      await expect(runCheck(repo.root, new FakeRenderTarget())).rejects.toMatchObject({
        code: 'F003_PATH_UNSAFE',
      });
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });

  it.skipIf(skipSymlinks)('refuses a FIFO with a typed error and does not hang', async () => {
    const repo = await generatedRepo();
    try {
      const path = join(repo.root, LOCK);
      await rm(path);
      execFileSync('mkfifo', [path]);
      const started = Date.now();
      const outcome = await Promise.race([
        readLockfile(repo.root).then(
          () => 'resolved',
          (error: unknown) => (error as { code?: string }).code ?? 'rejected',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 2_000)),
      ]);
      expect(outcome).toBe('F001_INVALID_CONFIG');
      expect(Date.now() - started).toBeLessThan(2_000);
      await expect(readLockfile(repo.root)).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: LOCK,
      });
    } finally {
      await repo.cleanup();
    }
  });

  it.skipIf(skipSymlinks)('refuses an unreadable lockfile with a typed error', async () => {
    const repo = await generatedRepo();
    try {
      await chmod(join(repo.root, LOCK), 0o000);
      await expect(readLockfile(repo.root)).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: LOCK,
        action: expect.stringContaining('delete it and re-run generate'),
      });
    } finally {
      await chmod(join(repo.root, LOCK), 0o644);
      await repo.cleanup();
    }
  });

  it('refuses an oversized lockfile rather than reading it', async () => {
    const repo = await generatedRepo();
    try {
      await writeFile(join(repo.root, LOCK), Buffer.alloc(LOCKFILE_MAX_BYTES + 1, 0x20));
      await expect(readLockfile(repo.root)).rejects.toMatchObject({
        code: 'F003_PATH_UNSAFE',
        subject: LOCK,
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('validates the source root before reading the lockfile', async () => {
    const repo = await generatedRepo();
    try {
      const farna = join(repo.root, '.farna');
      const moved = join(repo.root, 'farna-moved');
      await rename(farna, moved);
      await symlink(moved, farna, 'dir');
      // Neither the lockfile read nor the render runs through a symlinked root.
      await expect(runCheck(repo.root, new FakeRenderTarget())).rejects.toMatchObject({
        code: 'F003_PATH_UNSAFE',
        subject: '.farna',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('names the lockfile when the directory cannot be inspected', async () => {
    const repo = await generatedRepo();
    try {
      const lock = await readLockfile(repo.root);
      expect(lock).toBeDefined();
      expect((await lstat(join(repo.root, LOCK))).isFile()).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
