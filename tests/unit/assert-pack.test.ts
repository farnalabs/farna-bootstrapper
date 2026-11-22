import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../scripts/assert-pack.mjs', import.meta.url));

const BUILD_SCRIPT = `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist/cli', { recursive: true });
writeFileSync('dist/cli/main.js', '#!/usr/bin/env node\\n');
writeFileSync('dist/index.js', 'export {};\\n');
writeFileSync('dist/index.d.ts', 'export {};\\n');
if (existsSync('emit-map')) writeFileSync('dist/index.js.map', '{}');
`;

type Fixture = {
  root: string;
  cleanup: () => Promise<void>;
};

async function fixture(options: {
  prepack: boolean;
  staleDist: boolean;
  legal?: boolean;
  leak?: boolean;
  strayRoot?: boolean;
  sourceMap?: boolean;
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'fbs-pack-'));
  const legal = options.legal !== false;
  const files = legal
    ? ['dist', 'package.json', 'LICENSE', 'NOTICE', 'README.md', 'CHANGELOG.md', 'SECURITY.md']
    : ['dist', 'package.json'];
  if (options.strayRoot === true) {
    files.push('notes.txt');
  }
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'pack-fixture',
        version: '0.0.0',
        files: options.leak === true ? [...files, 'src'] : files,
        ...(options.prepack ? { scripts: { prepack: 'node build.mjs' } } : {}),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(join(root, 'build.mjs'), BUILD_SCRIPT, 'utf8');
  if (legal) {
    await writeFile(join(root, 'LICENSE'), 'MIT\n', 'utf8');
    await writeFile(join(root, 'NOTICE'), 'Notice\n', 'utf8');
    await writeFile(join(root, 'README.md'), '# pack-fixture\n', 'utf8');
    await writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
    await writeFile(join(root, 'SECURITY.md'), '# Security\n', 'utf8');
  }
  if (options.strayRoot === true) {
    // A file under `files` that the allowlist does not name. It is not in any
    // forbidden directory, so only an allowlist can catch it.
    await writeFile(join(root, 'notes.txt'), 'internal notes\n', 'utf8');
  }
  if (options.sourceMap === true) {
    // The build script emits `dist/index.js.map` when this marker is present.
    await writeFile(join(root, 'emit-map'), '', 'utf8');
  }
  if (options.leak === true) {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/leak.ts'), 'export const leaked = true;\n', 'utf8');
  }
  if (options.staleDist) {
    await mkdir(join(root, 'dist/cli'), { recursive: true });
    await writeFile(join(root, 'dist/cli/main.js'), 'stale\n', 'utf8');
    await writeFile(join(root, 'dist/index.js'), 'stale\n', 'utf8');
    await writeFile(join(root, 'dist/index.d.ts'), 'stale\n', 'utf8');
  }
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function runGate(root: string): Promise<{ code: number; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [SCRIPT], { cwd: root, timeout: 120_000 });
    return { code: 0, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stderr: failure.stderr ?? '',
    };
  }
}

describe('the published-tarball gate', () => {
  it('passes when prepack builds the entry points', async () => {
    const project = await fixture({ prepack: true, staleDist: false });
    try {
      expect(existsSync(join(project.root, 'dist'))).toBe(false);
      const result = await runGate(project.root);
      expect(result.code).toBe(0);
      // The concurrency lock is released on the normal path.
      expect(existsSync(join(project.root, 'dist.farna-pack-gate.lock'))).toBe(false);
    } finally {
      await project.cleanup();
    }
  });

  it('fails when prepack is missing, even with a stale dist on disk', async () => {
    const project = await fixture({ prepack: false, staleDist: true });
    try {
      const result = await runGate(project.root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('prepack');
      // The caller's build is restored, not deleted by the gate.
      expect(existsSync(join(project.root, 'dist/cli/main.js'))).toBe(true);
    } finally {
      await project.cleanup();
    }
  });

  it('fails when prepack is missing and there is no dist at all', async () => {
    const project = await fixture({ prepack: false, staleDist: false });
    try {
      const result = await runGate(project.root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('missing from the tarball');
    } finally {
      await project.cleanup();
    }
  });

  it('fails when a legal file is not in the tarball', async () => {
    const project = await fixture({ prepack: true, staleDist: false, legal: false });
    try {
      const result = await runGate(project.root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('LICENSE');
      expect(result.stderr).toContain('NOTICE');
      expect(result.stderr).toContain('README.md');
    } finally {
      await project.cleanup();
    }
  });

  it('fails when a repository-only path is in the tarball', async () => {
    const project = await fixture({ prepack: true, staleDist: false, leak: true });
    try {
      const result = await runGate(project.root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('repository-only path');
      expect(result.stderr).toContain('src/leak.ts');
    } finally {
      await project.cleanup();
    }
  });

  it('fails when a root file outside the allowlist reaches the tarball', async () => {
    // Not in a forbidden directory: only the allowlist can refuse it.
    const project = await fixture({ prepack: true, staleDist: false, strayRoot: true });
    try {
      const result = await runGate(project.root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('repository-only path');
      expect(result.stderr).toContain('notes.txt');
      expect(result.stderr).toContain('allowlist');
    } finally {
      await project.cleanup();
    }
  });

  it('fails when the tarball carries a source map', async () => {
    const project = await fixture({
      prepack: true,
      staleDist: false,
      sourceMap: true,
    });
    try {
      const result = await runGate(project.root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('source map');
      expect(result.stderr).toContain('dist/index.js.map');
      expect(result.stderr).toContain('declarationMap');
    } finally {
      await project.cleanup();
    }
  });

  it('does not throw on a leftover stash from a crashed earlier run', async () => {
    // Both a build to move aside and the old fixed stash name must be present:
    // the old script renamed `dist` onto the non-empty leftover and threw an
    // uncaught ENOTEMPTY. A unique per-run stash cannot collide with it, and it
    // never deletes a directory it did not create.
    const project = await fixture({ prepack: true, staleDist: true });
    try {
      await mkdir(join(project.root, 'dist.farna-pack-gate'), { recursive: true });
      await writeFile(join(project.root, 'dist.farna-pack-gate', 'leftover'), 'x', 'utf8');
      const result = await runGate(project.root);
      expect(result.code).toBe(0);
      expect(existsSync(join(project.root, 'dist.farna-pack-gate', 'leftover'))).toBe(true);
    } finally {
      await project.cleanup();
    }
  });
});
