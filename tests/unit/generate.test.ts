import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { formatGenerate } from '../../src/report/format.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createTempRepo, hashTree, readText } from '../support/temp-repo.js';

type GeneratedShape = {
  targets: Array<{
    personas: string[];
    files: Array<{ path: string; status: string }>;
  }>;
  files: Array<{ path: string; status: string }>;
};

/** Every planned path across every target and the run-level lockfile, in path order. */
function allFiles(result: GeneratedShape): Array<{ path: string; status: string }> {
  return [...result.targets.flatMap((target) => target.files), ...result.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/** Every live persona across every target. */
function allPersonas(result: GeneratedShape): string[] {
  return result.targets.flatMap((target) => target.personas);
}

describe('generate with the injected renderer', () => {
  it('writes one agent file per persona with its own rule text', async () => {
    const repo = await createTempRepo();
    try {
      const result = await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());

      expect(allPersonas(result)).toEqual(['builder', 'reviewer']);
      expect(allFiles(result).map((file) => file.path)).toEqual([
        '.claude/agents/builder.md',
        '.claude/agents/reviewer.md',
        '.farna/lock.json',
      ]);
      expect(allFiles(result).every((file) => file.status === 'written')).toBe(true);

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
        targets: Record<
          string,
          {
            personas: Array<{ id: string }>;
            files: Array<{ path: string; sha256: string; size: number }>;
          }
        >;
      };
      expect(lock.schemaVersion).toBe(2);
      expect(lock.renderer.name).toBe('fake-renderer');
      expect(lock.renderer.version).toBe('0.0.0-test');
      const target = lock.targets['claudecode'];
      expect(target?.personas.map((persona) => persona.id)).toEqual(['builder', 'reviewer']);
      expect(target?.files.map((file) => file.path)).toEqual([
        '.claude/agents/builder.md',
        '.claude/agents/reviewer.md',
      ]);
      expect(target?.files.every((file) => file.sha256.length === 64)).toBe(true);
      expect(target?.files.every((file) => file.size > 0)).toBe(true);
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
      expect(allFiles(result).map((file) => file.path)).toEqual([
        '.claude/agents/builder.md',
        '.claude/agents/reviewer.md',
        '.farna/lock.json',
      ]);
      expect(allFiles(result).every((file) => file.status === 'would-write')).toBe(true);
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('summarises a dry-run by would-write count, not the size of the plan', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const clean = await runGenerate({ cwd: repo.root, dryRun: true }, new FakeRenderTarget());
      expect(formatGenerate(clean)).toContain('would write 0 file(s), 2 unchanged');

      await appendFile(join(repo.root, '.claude/agents/reviewer.md'), ' ', 'utf8');
      const drifted = await runGenerate({ cwd: repo.root, dryRun: true }, new FakeRenderTarget());
      expect(formatGenerate(drifted)).toContain('would write 1 file(s), 1 unchanged');
    } finally {
      await repo.cleanup();
    }
  });

  it('dry-run reports unchanged on a tree that already matches a fresh render', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const before = await hashTree(repo.root);
      const result = await runGenerate({ cwd: repo.root, dryRun: true }, new FakeRenderTarget());
      expect(allFiles(result).map((file) => file.status)).toEqual([
        'unchanged',
        'unchanged',
        'unchanged',
      ]);
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('dry-run reports exactly the one edited file as would-write', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      await appendFile(join(repo.root, '.claude/agents/reviewer.md'), ' ', 'utf8');
      const before = await hashTree(repo.root);
      const result = await runGenerate({ cwd: repo.root, dryRun: true }, new FakeRenderTarget());
      const changed = allFiles(result).filter((file) => file.status === 'would-write');
      expect(changed.map((file) => file.path)).toEqual(['.claude/agents/reviewer.md']);
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('omits model from the artefact when the persona declares none', async () => {
    const repo = await createTempRepo();
    try {
      const personaPath = join(repo.root, '.farna/personas/builder.yaml');
      const source = await readFile(personaPath, 'utf8');
      await writeFile(personaPath, source.replace('model: standard\n', ''), 'utf8');
      const result = await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      expect(allPersonas(result)).toEqual(['builder', 'reviewer']);
      const builder = await readText(repo.root, '.claude/agents/builder.md');
      expect(builder).not.toContain('model:');
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
