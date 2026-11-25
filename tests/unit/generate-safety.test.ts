import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FarnaError } from '../../src/core/errors.js';
import { parseJsonc } from '../../src/core/json.js';
import { readLockfile } from '../../src/lock/lockfile.js';
import { withGenerateLock } from '../../src/render/generate-lock.js';
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

type LockTargetDocument = {
  mode?: string;
  activePersona?: string | null;
  notLive?: string[];
  files: Array<Record<string, unknown> & { path: string }>;
};

function parseLock(text: string): {
  schemaVersion: number;
  configDigest?: string;
  targets: Record<string, LockTargetDocument>;
} {
  return JSON.parse(text) as ReturnType<typeof parseLock>;
}

/** The single target entry of a one-target run. */
function targetOf(document: ReturnType<typeof parseLock>): LockTargetDocument {
  const [entry] = Object.values(document.targets);
  if (entry === undefined) {
    throw new Error('expected one target entry');
  }
  return entry;
}

/** Every generated path across every target entry. */
function lockPaths(document: ReturnType<typeof parseLock>): string[] {
  return Object.values(document.targets).flatMap((entry) => entry.files.map((file) => file.path));
}

/** Every removed path across every target and the run. */
function allRemoved(result: {
  targets: Array<{ removed: Array<{ path: string; status: string }> }>;
  removed: Array<{ path: string; status: string }>;
}): Array<{ path: string; status: string }> {
  return [...result.targets.flatMap((target) => target.removed), ...result.removed];
}

async function writeLock(repo: TempRepo, pid: number | undefined): Promise<void> {
  await mkdir(join(repo.root, GENERATE_LOCK), { recursive: true });
  if (pid !== undefined) {
    await writeFile(join(repo.root, GENERATE_LOCK, 'pid'), `${pid}\n`, 'utf8');
  }
}

describe('the generate lock', () => {
  it('refuses a second live run with F001 and releases the lock directory in a finally', async () => {
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

  it('reclaims a lock directory whose owner pid is dead', async () => {
    const repo = await createTempRepo('profile');
    try {
      // 2^31-1 is not a live pid on any supported platform.
      await writeLock(repo, 2147483646);
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

  it('reclaims a lock older than the age bound even while its pid is alive', async () => {
    const repo = await createTempRepo('profile');
    try {
      await writeLock(repo, process.pid);
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await utimes(join(repo.root, GENERATE_LOCK), old, old);
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

  it('reclaims a pid-less lock directory only once it is older than the grace window', async () => {
    const repo = await createTempRepo('profile');
    try {
      await writeLock(repo, undefined);
      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
      ).rejects.toMatchObject({ code: 'F001_INVALID_CONFIG', subject: GENERATE_LOCK });
    } finally {
      await repo.cleanup();
    }
  });

  it('honours a lock directory held by a live pid', async () => {
    const repo = await createTempRepo('profile');
    try {
      await writeLock(repo, process.pid);
      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
      ).rejects.toMatchObject({ code: 'F001_INVALID_CONFIG', subject: GENERATE_LOCK });
    } finally {
      await repo.cleanup();
    }
  });

  it('releases the lock when the body throws', async () => {
    const repo = await createTempRepo('profile');
    try {
      await expect(
        withGenerateLock(repo.root, async () => {
          throw new Error('body failed');
        }),
      ).rejects.toThrow('body failed');
      // The released lock must be acquirable again immediately.
      const value = await withGenerateLock(repo.root, async () => 'acquired');
      expect(value).toBe('acquired');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a non-directory at the lock path as a typed error, not "already running"', async () => {
    const repo = await createTempRepo('profile');
    try {
      await writeFile(join(repo.root, GENERATE_LOCK), 'not a lock directory\n', 'utf8');
      let failure: FarnaError | undefined;
      try {
        await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      } catch (error) {
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F001_INVALID_CONFIG');
      expect(failure?.subject).toBe(GENERATE_LOCK);
      expect(failure?.message).toContain('is not a directory');
      expect(failure?.message).not.toContain('another generate');
    } finally {
      await repo.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO at the lock path without hanging',
    async () => {
      const repo = await createTempRepo('profile');
      try {
        execFileSync('mkfifo', [join(repo.root, GENERATE_LOCK)]);
        const started = Date.now();
        const outcome = await Promise.race([
          runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()).then(
            () => 'resolved',
            (error: unknown) => (error as { code?: string }).code ?? 'rejected',
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 5_000)),
        ]);
        expect(outcome).toBe('F001_INVALID_CONFIG');
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        await repo.cleanup();
      }
    },
  );

  it('validates .farna before taking the lock, so a broken source root reports itself', async () => {
    const repo = await createTempRepo('profile');
    try {
      const root = join(repo.root, '.farna');
      const moved = join(repo.root, 'farna-moved');
      await rename(root, moved);
      await writeFile(root, 'not a directory\n', 'utf8');
      let failure: FarnaError | undefined;
      try {
        await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      } catch (error) {
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F001_INVALID_CONFIG');
      expect(failure?.subject).toBe('.farna');
      expect(failure?.message).toContain('is not a directory');
      expect(failure?.subject).not.toBe(GENERATE_LOCK);
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
      targetOf(document).files.push({ path: 'notes.txt', sha256: '0'.repeat(64), size: 0 });
      await writeFile(lockPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

      await setActive(repo, 'reviewer');
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.ok).toBe(true);
      const rewritten = parseLock(await readFile(lockPath, 'utf8'));
      expect(lockPaths(rewritten)).not.toContain('notes.txt');
    } finally {
      await repo.cleanup();
    }
  });

  it('names the removals already made when a later removal fails', async () => {
    const repo = await generated();
    try {
      const lock = await readLockfile(repo.root);
      const recordings = Object.values(lock?.targets ?? {}).flatMap((target) => target.files);
      const first = recordings.find((file) => file.path === '.opencode/agents/builder.md');
      const second = recordings.find((file) => file.path === '.opencode/commands/pytest.md');
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      // A directory in the way fails the second removal after the first lands.
      await rm(join(repo.root, '.opencode/commands/pytest.md'));
      await mkdir(join(repo.root, '.opencode/commands/pytest.md'));

      let failure: FarnaError | undefined;
      try {
        await removeOrphans(
          repo.root,
          [first, second].filter((entry) => entry !== undefined),
        );
      } catch (error) {
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F012_WRITE_FAILED');
      expect(failure?.message).toContain('already removed 1 recorded path(s)');
      expect(failure?.message).toContain('.opencode/agents/builder.md');
      expect(failure?.message).toContain('partially updated');
      await expect(lstat(join(repo.root, '.opencode/agents/builder.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('re-checks a recorded orphan immediately before removing it (TOCTOU)', async () => {
    const repo = await generated();
    try {
      const lock = await readLockfile(repo.root);
      const entry = Object.values(lock?.targets ?? {})
        .flatMap((target) => target.files)
        .find((file) => file.path === '.opencode/agents/builder.md');
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

  it('deletes only the owned key from a structured orphan and keeps the user keys and comment', async () => {
    const repo = await generated();
    try {
      const configPath = join(repo.root, 'opencode.jsonc');
      const document = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      // A comment is the byte a whole-file removal would destroy; the user's key
      // is what makes the file theirs after the owned key is gone. The trailing
      // comma is the shape that must still parse after the owned key is deleted.
      const mcp = JSON.stringify(document['mcp'], null, 2).replaceAll('\n', '\n  ');
      await writeFile(
        configPath,
        `// keep me\n{\n  "theme": "dark",\n  "mcp": ${mcp},\n}\n`,
        'utf8',
      );

      const personaPath = join(repo.root, '.farna/personas/builder.yaml');
      const persona = await readFile(personaPath, 'utf8');
      await writeFile(personaPath, persona.replace('  - mcp/scan\n', ''), 'utf8');

      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.ok).toBe(true);
      expect(allRemoved(result)).toContainEqual({ path: 'opencode.jsonc', status: 'updated' });
      const after = await readFile(configPath, 'utf8');
      expect(after).toContain('// keep me');
      expect(after).not.toContain('"mcp"');
      expect(parseJsonc<Record<string, unknown>>(after, { subject: 'opencode.jsonc' })).toEqual({
        theme: 'dark',
      });
      const lock = parseLock(await readFile(join(repo.root, '.farna/lock.json'), 'utf8'));
      expect(lockPaths(lock)).not.toContain('opencode.jsonc');

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
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
      const document = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
      const targets = document['targets'] as Record<string, Record<string, unknown>>;
      const entry = targets['opencode'];
      if (entry === undefined) {
        throw new Error('expected an opencode target entry');
      }
      delete entry['mode'];
      delete entry['activePersona'];
      delete entry['notLive'];
      delete document['configDigest'];
      const version1 = {
        schemaVersion: 1,
        product: document['product'],
        target: 'opencode',
        ...entry,
        renderer: document['renderer'],
        warnings: document['warnings'],
      };
      await writeFile(lockPath, `${JSON.stringify(version1, null, 2)}\n`, 'utf8');

      await setActive(repo, 'reviewer');
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      const removed = allRemoved(result).map((entry) => entry.path);
      expect(removed).toContain('.opencode/agents/builder.md');
      expect(removed).toContain('.opencode/commands/pytest.md');
      await expect(lstat(join(repo.root, '.opencode/agents/builder.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const rewritten = parseLock(await readFile(lockPath, 'utf8'));
      expect(rewritten.schemaVersion).toBe(2);
      expect(targetOf(rewritten).mode).toBe('profile');
      expect(targetOf(rewritten).activePersona).toBe('reviewer');
      expect(targetOf(rewritten).notLive).toEqual(['builder']);
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
