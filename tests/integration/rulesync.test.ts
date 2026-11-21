import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { installedRendererIdentity } from '../../src/render/identity.js';
import { RENDERER_PIN, UpstreamRenderTarget } from '../../src/render/upstream.js';
import { createEmptyTempDir, createTempRepo, hashTree, readText } from '../support/temp-repo.js';

/**
 * The real, pinned renderer. There is no skip: a missing or broken `rulesync`
 * fails collection loudly, because these are the only tests that can detect a
 * renderer regression. CI asserts that the expected number of these tests ran.
 */
describe('rulesync integration', () => {
  it('pins the renderer version and integrity that are actually installed', async () => {
    const manifest = JSON.parse(
      await readFile(join(process.cwd(), 'node_modules/rulesync/package.json'), 'utf8'),
    ) as { version: string };
    expect(manifest.version).toBe(RENDERER_PIN.version);
    expect(RENDERER_PIN.name).toBe('rulesync');
    expect(RENDERER_PIN.integrity).toMatch(/^sha512-/);

    const installed = installedRendererIdentity('rulesync');
    expect(installed.version).toBe(RENDERER_PIN.version);
    expect(installed.integrity).toBe(RENDERER_PIN.integrity);
    expect(await new UpstreamRenderTarget().identity()).toEqual(installed);
  });

  it('renders two isolated Claude Code agent files through the real renderer', async () => {
    const repo = await createTempRepo();
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.files.map((file) => file.path)).toEqual([
        '.claude/agents/builder.md',
        '.claude/agents/reviewer.md',
        '.farna/lock.json',
      ]);

      const builder = await readText(repo.root, '.claude/agents/builder.md');
      const reviewer = await readText(repo.root, '.claude/agents/reviewer.md');

      expect(builder).toContain('name: builder');
      expect(builder).toContain('Writes code, runs the tests');
      expect(builder).toContain('model: claude-sonnet-4-5');
      expect(builder).toContain('FBS_RULE_BUILDER_4a1c');
      expect(builder).not.toContain('FBS_RULE_REVIEWER_8d2f');

      expect(reviewer).toContain('name: reviewer');
      expect(reviewer).toContain('FBS_RULE_REVIEWER_8d2f');
      expect(reviewer).not.toContain('FBS_RULE_BUILDER_4a1c');

      const lock = JSON.parse(await readText(repo.root, '.farna/lock.json')) as {
        renderer: { name: string; version: string; integrity: string };
      };
      // The lockfile records the build's pin, not the integrity this machine's
      // package manager happened to write, so two machines agree byte for byte.
      expect(lock.renderer).toEqual(RENDERER_PIN);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  it('generates and checks a persona that declares no rules', async () => {
    const repo = await createTempRepo();
    try {
      await mkdir(join(repo.root, '.farna/resources/permissions'), { recursive: true });
      await writeFile(
        join(repo.root, '.farna/resources/permissions/locked.jsonc'),
        JSON.stringify(
          { kind: 'permission', id: 'locked', tools: { read: 'allow' }, allowlist: true },
          null,
          2,
        ),
        'utf8',
      );
      await writeFile(
        join(repo.root, '.farna/personas/empty.yaml'),
        [
          'kind: persona',
          'id: empty',
          'displayName: Empty',
          'purpose: A persona with no rules.',
          'resources:',
          '  - permission/locked',
          '',
        ].join('\n'),
        'utf8',
      );
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const text = await readText(repo.root, '.claude/agents/empty.md');
      expect(text.startsWith('---\n')).toBe(true);
      expect(text).toContain('name: empty');
      expect(text).toContain('- Read');
      // The honest renderer emits no body when there are no rules.
      expect(text.endsWith('---\n')).toBe(true);

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.exitCode).toBe(0);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  it('ignores an ambient rulesync config in the working directory', async () => {
    const ambient = await createEmptyTempDir();
    const repo = await createTempRepo();
    const previous = process.cwd();
    try {
      // `delete` and `dryRun` are the two options an ambient file could use to
      // change the run. With the stage as the renderer's working directory they
      // are never read.
      await writeFile(
        join(ambient.root, 'rulesync.jsonc'),
        JSON.stringify({ dryRun: true, delete: true, check: true }),
        'utf8',
      );
      process.chdir(ambient.root);
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.files.every((file) => file.status === 'written')).toBe(true);
      const builder = await readText(repo.root, '.claude/agents/builder.md');
      expect(builder).toContain('name: builder');
      // The renderer changed the process working directory for its call; it
      // must be restored so a second render in this process is unaffected.
      expect(process.cwd()).toBe(ambient.root);
    } finally {
      process.chdir(previous);
      await repo.cleanup();
      await ambient.cleanup();
    }
  }, 30_000);

  it('restores the working directory when the renderer throws', async () => {
    const repo = await createTempRepo();
    const previous = process.cwd();
    try {
      const missing = join(repo.root, 'missing-stage');
      await expect(
        new UpstreamRenderTarget().generate({
          target: 'claudecode',
          stageRoot: missing,
          sourceRoot: missing,
          outputRoot: missing,
        }),
      ).rejects.toMatchObject({ code: 'F009_RENDER_FAILED' });
      expect(process.cwd()).toBe(previous);
    } finally {
      process.chdir(previous);
      await repo.cleanup();
    }
  });

  it('check is clean immediately after generate and fails after an edit', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const clean = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(clean.ok).toBe(true);
      expect(clean.exitCode).toBe(0);

      const before = await hashTree(repo.root);
      const file = join(repo.root, '.claude/agents/reviewer.md');
      const edited = `${await readFile(file, 'utf8')}\nmanual edit\n`;
      await writeFile(file, edited, 'utf8');

      const drifted = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(drifted.ok).toBe(false);
      expect(drifted.exitCode).toBe(1);
      expect(drifted.drift.map((item) => item.path)).toContain('.claude/agents/reviewer.md');
      expect(await hashTree(repo.root)).not.toBe(before);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});
