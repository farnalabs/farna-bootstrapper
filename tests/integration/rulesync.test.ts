import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { RENDERER_PIN, UpstreamRenderTarget } from '../../src/render/upstream.js';
import { createTempRepo, hashTree, readText } from '../support/temp-repo.js';

let rulesyncInstalled = true;
try {
  await import('rulesync');
} catch {
  rulesyncInstalled = false;
}

describe.skipIf(!rulesyncInstalled)('rulesync integration', () => {
  it('pins the renderer version that is actually installed', async () => {
    const manifest = JSON.parse(
      await readFile(join(process.cwd(), 'node_modules/rulesync/package.json'), 'utf8'),
    ) as { version: string };
    expect(manifest.version).toBe(RENDERER_PIN.version);
    expect(RENDERER_PIN.name).toBe('rulesync');
    expect(RENDERER_PIN.integrity.startsWith('sha512-')).toBe(true);
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
        renderer: { name: string; version: string };
      };
      expect(lock.renderer).toMatchObject({ name: 'rulesync', version: RENDERER_PIN.version });
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

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
