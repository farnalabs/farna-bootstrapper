import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NPM_LOCKFILE_MAX_BYTES } from '../../src/core/constants.js';
import { createTempRepo, hashTree } from '../support/temp-repo.js';

/**
 * A published package installed into a *global* prefix has no npm lockfile
 * recording the renderer's tarball integrity. These tests reproduce that layout
 * without the network: the tarball is unpacked into `<prefix>/lib/node_modules/
 * <name>`, the renderer is COPIED (not symlinked) so its resolved path stays
 * inside the prefix and no ancestor lockfile can be found, and every other
 * dependency is symlinked from the checkout.
 */

const ROOT = process.cwd();
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const GLOBAL_ENTRY = join('dist', 'cli', 'main.js');

async function packTarball(): Promise<string> {
  const raw = execFileSync(NPM, ['pack', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 300_000,
  });
  const parsed = JSON.parse(raw) as Array<{ filename: string }>;
  const filename = parsed[0]?.filename;
  if (filename === undefined) {
    throw new Error('npm pack returned no filename');
  }
  return join(ROOT, filename);
}

async function unpackInto(tarball: string, packageDir: string): Promise<void> {
  await mkdir(packageDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', packageDir, '--strip-components=1'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 60_000,
  });
}

/**
 * Give the unpacked package a `node_modules`. The renderer is copied so it is
 * resolved from inside the prefix; the rest are symlinked to keep the fixture
 * cheap.
 */
async function installDependencies(packageDir: string, includeRenderer: boolean): Promise<void> {
  const target = join(packageDir, 'node_modules');
  await mkdir(target, { recursive: true });
  if (includeRenderer) {
    await cp(join(ROOT, 'node_modules', 'rulesync'), join(target, 'rulesync'), {
      recursive: true,
    });
  }
  for (const name of await readdir(join(ROOT, 'node_modules'))) {
    if (name.startsWith('.') || name === 'rulesync') {
      continue;
    }
    await symlink(join(ROOT, 'node_modules', name), join(target, name), 'dir');
  }
}

function run(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe.skipIf(process.platform === 'win32')('install layouts', () => {
  it('runs generate from a tarball in a temporary global prefix with no npm lock record', async () => {
    const prefix = await mkdtemp(join(tmpdir(), 'fbs-global-'));
    const tarball = await packTarball();
    const repo = await createTempRepo('demo');
    try {
      const packageDir = join(prefix, 'lib', 'node_modules', 'farna-bootstrapper');
      await unpackInto(tarball, packageDir);
      // The published tarball ships dist; this test is about the missing lock
      // record, not about building.
      expect(existsSync(join(packageDir, GLOBAL_ENTRY))).toBe(true);
      await installDependencies(packageDir, true);

      const result = run(repo.root, [join(packageDir, GLOBAL_ENTRY), 'generate', '--json']);
      expect(result.stderr).not.toContain('F010_RENDERER_MISMATCH');
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as { ok: boolean; renderer?: unknown };
      expect(body.ok).toBe(true);
      expect(existsSync(join(repo.root, '.claude', 'agents', 'builder.md'))).toBe(true);
    } finally {
      await rm(tarball, { force: true });
      await repo.cleanup();
      await rm(prefix, { recursive: true, force: true });
    }
  }, 300_000);

  it('refuses an over-size npm lock record instead of falling back to the pin', async () => {
    const prefix = await mkdtemp(join(tmpdir(), 'fbs-oversized-record-'));
    const tarball = await packTarball();
    const repo = await createTempRepo('demo');
    try {
      const packageDir = join(prefix, 'lib', 'node_modules', 'farna-bootstrapper');
      await unpackInto(tarball, packageDir);
      await installDependencies(packageDir, true);

      // A present lock record that is over the npm bound must be refused, not
      // skipped: skipping it would let this differing integrity pass through
      // the compile-time pin. Valid JSON just past the bound keeps the record
      // parseable, so only the size bound can be what refuses it. The bound is
      // the npm-record bound, not the small derived-lockfile one: a 5 MiB
      // monorepo record is legitimate and must be read.
      //
      // The record is written to one of the two supported paths: the hidden
      // record at the install root (`<prefix>/lib`, the nearest ancestor of the
      // product package that owns a `node_modules` directory). A record beside
      // the product package's own nested `node_modules` is not one of the two
      // supported paths, so it would yield W114 rather than refuse.
      const record = JSON.stringify({
        packages: { 'node_modules/rulesync': { integrity: 'sha512-DIFFERENT-NOT-THE-PIN' } },
        padding: 'x'.repeat(NPM_LOCKFILE_MAX_BYTES),
      });
      expect(Buffer.byteLength(record)).toBeGreaterThan(NPM_LOCKFILE_MAX_BYTES);
      await writeFile(join(prefix, 'lib', 'node_modules', '.package-lock.json'), record, 'utf8');

      const before = await hashTree(repo.root);
      const result = run(repo.root, [join(packageDir, GLOBAL_ENTRY), 'generate', '--json']);

      expect(result.status, result.stderr).toBe(5);
      expect(result.stderr).toContain('F010_RENDERER_MISMATCH');
      expect(result.stderr).toContain('.package-lock.json');
      expect(result.stderr).toContain(`${Buffer.byteLength(record)} bytes`);
      const body = JSON.parse(result.stdout) as { ok: boolean; code: string; exitCode: number };
      expect(body.ok).toBe(false);
      expect(body.code).toBe('F010_RENDERER_MISMATCH');
      expect(body.exitCode).toBe(5);
      // Nothing was rendered or written: the identity check runs before the
      // render, so the tree is byte-for-byte what it was.
      expect(await hashTree(repo.root)).toBe(before);
      expect(existsSync(join(repo.root, '.claude', 'agents', 'builder.md'))).toBe(false);
    } finally {
      await rm(tarball, { force: true });
      await repo.cleanup();
      await rm(prefix, { recursive: true, force: true });
    }
  }, 300_000);

  it('maps a missing renderer to a typed diagnostic, while --version and init still work', async () => {
    const prefix = await mkdtemp(join(tmpdir(), 'fbs-no-renderer-'));
    const tarball = await packTarball();
    const repo = await createTempRepo('demo');
    try {
      const packageDir = join(prefix, 'lib', 'node_modules', 'farna-bootstrapper');
      await unpackInto(tarball, packageDir);
      await installDependencies(packageDir, false);

      const version = run(repo.root, [join(packageDir, GLOBAL_ENTRY), '--version']);
      expect(version.status).toBe(0);
      expect(version.stdout).toContain('43.12.0');

      const initRoot = await mkdtemp(join(tmpdir(), 'fbs-init-'));
      try {
        const init = run(initRoot, [join(packageDir, GLOBAL_ENTRY), 'init', '--json']);
        expect(init.status, init.stderr).toBe(0);
      } finally {
        await rm(initRoot, { recursive: true, force: true });
      }

      const generated = run(repo.root, [join(packageDir, GLOBAL_ENTRY), 'generate', '--json']);
      expect(generated.status).toBe(5);
      expect(generated.stderr).toContain('F010_RENDERER_MISMATCH');
      expect(generated.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
      expect(generated.stderr).not.toMatch(/\n\s+at /);
      const body = JSON.parse(generated.stdout) as { ok: boolean; code: string };
      expect(body.ok).toBe(false);
      expect(body.code).toBe('F010_RENDERER_MISMATCH');
    } finally {
      await rm(tarball, { force: true });
      await repo.cleanup();
      await rm(prefix, { recursive: true, force: true });
    }
  }, 300_000);

  it('installs from a git URL and produces a working bin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fbs-git-install-'));
    const sourceRepo = join(root, 'source');
    const consumer = join(root, 'consumer');
    try {
      // A git dependency is cloned by npm, gets its dev dependencies, and npm
      // runs `prepare`; without that hook the installed package has no dist.
      await mkdir(sourceRepo, { recursive: true });
      for (const path of ['src', 'tsconfig.json', 'tsconfig.build.json']) {
        await cp(join(ROOT, path), join(sourceRepo, path), { recursive: true });
      }
      for (const path of ['package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'README.md']) {
        await cp(join(ROOT, path), join(sourceRepo, path));
      }
      execFileSync('git', ['init', '-q'], { cwd: sourceRepo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
        cwd: sourceRepo,
        stdio: 'ignore',
      });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: sourceRepo, stdio: 'ignore' });
      execFileSync('git', ['add', '-A'], { cwd: sourceRepo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: sourceRepo, stdio: 'ignore' });

      await mkdir(consumer, { recursive: true });
      await writeFile(
        join(consumer, 'package.json'),
        '{"name":"consumer","private":true}\n',
        'utf8',
      );
      execFileSync(
        NPM,
        ['install', '--no-audit', '--no-fund', '--loglevel=error', `git+file://${sourceRepo}`],
        {
          cwd: consumer,
          stdio: ['ignore', 'pipe', 'inherit'],
          timeout: 300_000,
        },
      );

      const installed = join(consumer, 'node_modules', 'farna-bootstrapper');
      expect(existsSync(join(installed, GLOBAL_ENTRY))).toBe(true);
      const version = run(consumer, [join(installed, GLOBAL_ENTRY), '--version']);
      expect(version.status).toBe(0);
      expect(version.stdout).toContain('farna-bootstrapper');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);

  it('builds its bin from a source checkout through the prepare lifecycle hook', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'fbs-prepare-'));
    try {
      // A git install checks out the source tree and npm runs `prepare`; the
      // checkout is every tracked build input, with node_modules reused.
      for (const path of ['src', 'tsconfig.json', 'tsconfig.build.json']) {
        await cp(join(ROOT, path), join(checkout, path), { recursive: true });
      }
      await cp(join(ROOT, 'package.json'), join(checkout, 'package.json'));
      await symlink(join(ROOT, 'node_modules'), join(checkout, 'node_modules'), 'dir');

      const manifest = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      expect(manifest.scripts?.['prepare']).toBe('npm run build');

      execFileSync(NPM, ['run', 'prepare'], {
        cwd: checkout,
        stdio: ['ignore', 'pipe', 'inherit'],
        timeout: 300_000,
      });
      expect(existsSync(join(checkout, GLOBAL_ENTRY))).toBe(true);
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  }, 300_000);
});
