import { lstat, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FarnaError } from '../../src/core/errors.js';
import { readLockfile } from '../../src/lock/lockfile.js';
import { removeOrphans } from '../../src/render/orphans.js';
import type {
  RendererIdentity,
  RenderRequest,
  RenderResult,
  RenderTarget,
} from '../../src/render/port.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';
import { createTempRepo, readText, type TempRepo } from '../support/temp-repo.js';

const skipPosixModes = process.platform === 'win32';
const GENERATE_LOCK = '.farna/.generate.lock';

async function generated(): Promise<TempRepo> {
  const repo = await createTempRepo('profile');
  await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
  return repo;
}

async function setActive(repo: TempRepo, persona: string): Promise<void> {
  const path = join(repo.root, '.farna/config.jsonc');
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace(/"active": "[^"]+"/, `"active": "${persona}"`), 'utf8');
}

/** The real renderer, paused inside `generate` until `release()` is called. */
class GatedRenderTarget implements RenderTarget {
  private readonly inner = new UpstreamRenderTarget();
  private releaseGate: () => void = () => undefined;
  private signalEntered: () => void = () => undefined;
  readonly entered = new Promise<void>((resolve) => {
    this.signalEntered = resolve;
  });
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  release(): void {
    this.releaseGate();
  }

  identity(): RendererIdentity {
    return this.inner.identity();
  }

  recordedIdentity(): RendererIdentity {
    return this.inner.recordedIdentity();
  }

  async generate(request: RenderRequest): Promise<RenderResult> {
    this.signalEntered();
    await this.gate;
    return await this.inner.generate(request);
  }
}

function parseLock(text: string): {
  mode?: string;
  activePersona?: string | null;
  notLive?: string[];
  configDigest?: string;
  files: Array<Record<string, unknown> & { path: string }>;
} {
  return JSON.parse(text) as ReturnType<typeof parseLock>;
}

describe('the generate lock', () => {
  it('refuses a second live run with F001 and releases the lock in a finally', async () => {
    const repo = await createTempRepo('profile');
    const renderer = new GatedRenderTarget();
    try {
      const first = runGenerate({ cwd: repo.root, dryRun: false }, renderer);
      await renderer.entered;

      let failure: FarnaError | undefined;
      try {
        await runGenerate({ cwd: repo.root, dryRun: false }, renderer);
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F001_INVALID_CONFIG');
      expect(failure?.subject).toBe(GENERATE_LOCK);
      expect(failure?.message).toContain('another generate is already running');

      renderer.release();
      const result = await first;
      expect(result.ok).toBe(true);
      await expect(lstat(join(repo.root, GENERATE_LOCK))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      renderer.release();
      await repo.cleanup();
    }
  });

  it('reclaims a lock whose owner pid is dead', async () => {
    const repo = await createTempRepo('profile');
    try {
      // 2^31-1 is not a live pid on any supported platform.
      await writeFile(join(repo.root, GENERATE_LOCK), '2147483646\n', 'utf8');
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.ok).toBe(true);
      await expect(lstat(join(repo.root, GENERATE_LOCK))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('honours a lock held by a live pid', async () => {
    const repo = await createTempRepo('profile');
    try {
      await writeFile(join(repo.root, GENERATE_LOCK), `${process.pid}\n`, 'utf8');
      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
      ).rejects.toMatchObject({ code: 'F001_INVALID_CONFIG', subject: GENERATE_LOCK });
    } finally {
      await repo.cleanup();
    }
  });
});

describe('removal honesty', () => {
  it('names the removals a later commit failure already made', async () => {
    const repo = await generated();
    try {
      await setActive(repo, 'reviewer');
      let failure: FarnaError | undefined;
      try {
        await runGenerate(
          {
            cwd: repo.root,
            dryRun: false,
            commitOperations: {
              rename: async () => {
                throw new Error('injected rename failure');
              },
            },
          },
          new UpstreamRenderTarget(),
        );
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F012_WRITE_FAILED');
      expect(failure?.message).toContain('already removed 5 recorded path(s)');
      expect(failure?.message).toContain('.opencode/agents/builder.md');
      expect(failure?.message).not.toContain('nothing was written');
      await expect(lstat(join(repo.root, '.opencode/agents/builder.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('drops a recorded path that is already absent, even outside a managed location', async () => {
    const repo = await generated();
    try {
      const lockPath = join(repo.root, '.farna/lock.json');
      const document = parseLock(await readFile(lockPath, 'utf8'));
      document.files.push({ path: 'notes.txt', sha256: '0'.repeat(64), size: 0 });
      await writeFile(lockPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

      await setActive(repo, 'reviewer');
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.ok).toBe(true);
      const rewritten = parseLock(await readFile(lockPath, 'utf8'));
      expect(rewritten.files.map((file) => file.path)).not.toContain('notes.txt');
    } finally {
      await repo.cleanup();
    }
  });

  it('re-checks a recorded orphan immediately before removing it (TOCTOU)', async () => {
    const repo = await generated();
    try {
      const lock = await readLockfile(repo.root);
      const entry = lock?.files.find((file) => file.path === '.opencode/agents/builder.md');
      expect(entry).toBeDefined();
      // The file changes after the preflight would have run.
      await writeFile(
        join(repo.root, '.opencode/agents/builder.md'),
        'a different document\n',
        'utf8',
      );
      await expect(
        removeOrphans(repo.root, entry === undefined ? [] : [entry]),
      ).rejects.toMatchObject({ code: 'F007_DRIFT' });
      expect(await readText(repo.root, '.opencode/agents/builder.md')).toBe(
        'a different document\n',
      );

      // A path that vanished between the preflight and the removal is reported,
      // not deleted and not silently called removed.
      await rm(join(repo.root, '.opencode/agents/builder.md'));
      expect(await removeOrphans(repo.root, entry === undefined ? [] : [entry])).toEqual([
        { path: '.opencode/agents/builder.md', status: 'missing' },
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a structured orphan that still carries user keys, then accepts a cleaned file', async () => {
    const repo = await generated();
    try {
      const configPath = join(repo.root, 'opencode.jsonc');
      const document = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      document['theme'] = 'dark';
      await writeFile(configPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

      const personaPath = join(repo.root, '.farna/personas/builder.yaml');
      const persona = await readFile(personaPath, 'utf8');
      await writeFile(personaPath, persona.replace('  - mcp/scan\n', ''), 'utf8');

      let failure: FarnaError | undefined;
      try {
        await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      } catch (error) {
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F007_DRIFT');
      expect(failure?.subject).toBe('opencode.jsonc');
      expect(failure?.message).toContain('does not own');
      expect(failure?.action).toContain('remove the mcp key');

      // The user removes the key this tool owned; the file is theirs now.
      const cleaned = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      delete cleaned['mcp'];
      await writeFile(configPath, `${JSON.stringify(cleaned, null, 2)}\n`, 'utf8');
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.ok).toBe(true);
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(cleaned);
      const lock = parseLock(await readFile(join(repo.root, '.farna/lock.json'), 'utf8'));
      expect(lock.files.map((file) => file.path)).not.toContain('opencode.jsonc');
    } finally {
      await repo.cleanup();
    }
  });
});

describe('legacy lockfiles', () => {
  it('still removes recorded orphans when the lockfile predates profile mode', async () => {
    const repo = await generated();
    try {
      const lockPath = join(repo.root, '.farna/lock.json');
      const document = parseLock(await readFile(lockPath, 'utf8'));
      delete document.mode;
      delete document.activePersona;
      delete document.notLive;
      delete document.configDigest;
      await writeFile(lockPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

      await setActive(repo, 'reviewer');
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      const removed = result.removed.map((entry) => entry.path);
      expect(removed).toContain('.opencode/agents/builder.md');
      expect(removed).toContain('.opencode/commands/pytest.md');
      await expect(lstat(join(repo.root, '.opencode/agents/builder.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const rewritten = parseLock(await readFile(lockPath, 'utf8'));
      expect(rewritten.mode).toBe('profile');
      expect(rewritten.activePersona).toBe('reviewer');
      expect(rewritten.notLive).toEqual(['builder']);
    } finally {
      await repo.cleanup();
    }
  });
});

describe.skipIf(skipPosixModes)('generated modes', () => {
  it('creates files 0644 and directories 0755 whatever the umask', async () => {
    const repo = await createTempRepo('profile');
    const previous = process.umask(0o000);
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());

      for (const path of [
        'opencode.jsonc',
        '.opencode/agents/builder.md',
        '.opencode/commands/pytest.md',
        '.opencode/plugins/rulesync-hooks.js',
        '.opencode/skills/secure-review/SKILL.md',
        '.farna/lock.json',
      ]) {
        expect((await stat(join(repo.root, path))).mode & 0o777, path).toBe(0o644);
      }
      for (const path of [
        '.opencode',
        '.opencode/agents',
        '.opencode/commands',
        '.opencode/plugins',
        '.opencode/skills',
        '.opencode/skills/secure-review',
        '.opencode/skills/secure-review/scripts',
      ]) {
        expect((await stat(join(repo.root, path))).mode & 0o777, path).toBe(0o755);
      }
    } finally {
      process.umask(previous);
      await repo.cleanup();
    }
  });
});
