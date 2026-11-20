import { describe, expect, it } from 'vitest';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createTempRepo, hashTree, readText } from '../support/temp-repo.js';

describe('generate with the injected renderer', () => {
  it('writes one agent file per persona with its own rule text', async () => {
    const repo = await createTempRepo();
    try {
      const result = await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());

      expect(result.personas).toEqual(['builder', 'reviewer']);
      expect(result.files.map((file) => file.path)).toEqual([
        '.claude/agents/builder.md',
        '.claude/agents/reviewer.md',
        '.farna/lock.json',
      ]);
      expect(result.files.every((file) => file.status === 'written')).toBe(true);

      const builder = await readText(repo.root, '.claude/agents/builder.md');
      const reviewer = await readText(repo.root, '.claude/agents/reviewer.md');

      expect(builder).toContain('FBS_RULE_BUILDER_4a1c');
      expect(builder).not.toContain('FBS_RULE_REVIEWER_8d2f');
      expect(reviewer).toContain('FBS_RULE_REVIEWER_8d2f');
      expect(reviewer).not.toContain('FBS_RULE_BUILDER_4a1c');

      expect(builder).toContain('name: builder');
      expect(builder).toContain('description: Writes code');
      expect(builder).toContain('model: claude-sonnet-4-5');
      expect(builder).toContain('## House style');
      expect(reviewer).toContain('## Review checklist');
    } finally {
      await repo.cleanup();
    }
  });

  it('writes a lockfile that records the renderer and the managed paths', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const lock = JSON.parse(await readText(repo.root, '.farna/lock.json')) as {
        schemaVersion: number;
        renderer: { name: string; version: string };
        personas: Array<{ id: string }>;
        files: Array<{ path: string; sha256: string; size: number }>;
      };
      expect(lock.schemaVersion).toBe(1);
      expect(lock.renderer.name).toBe('fake-renderer');
      expect(lock.renderer.version).toBe('0.0.0-test');
      expect(lock.personas.map((persona) => persona.id)).toEqual(['builder', 'reviewer']);
      expect(lock.files.map((file) => file.path)).toEqual([
        '.claude/agents/builder.md',
        '.claude/agents/reviewer.md',
      ]);
      expect(lock.files.every((file) => file.sha256.length === 64)).toBe(true);
      expect(lock.files.every((file) => file.size > 0)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('is idempotent: a second run writes nothing', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const before = await hashTree(repo.root);
      const second = await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      expect(second.files.every((file) => file.status === 'unchanged')).toBe(true);
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('dry-run writes nothing and reports the same plan', async () => {
    const repo = await createTempRepo();
    try {
      const before = await hashTree(repo.root);
      const result = await runGenerate({ cwd: repo.root, dryRun: true }, new FakeRenderTarget());
      expect(result.dryRun).toBe(true);
      expect(result.files.map((file) => file.path)).toEqual([
        '.claude/agents/builder.md',
        '.claude/agents/reviewer.md',
        '.farna/lock.json',
      ]);
      expect(result.files.every((file) => file.status === 'would-write')).toBe(true);
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('produces identical bytes in two independent roots', async () => {
    const first = await createTempRepo();
    const second = await createTempRepo();
    try {
      await runGenerate({ cwd: first.root, dryRun: false }, new FakeRenderTarget());
      await runGenerate({ cwd: second.root, dryRun: false }, new FakeRenderTarget());
      expect(await hashTree(first.root)).toBe(await hashTree(second.root));
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });
});
