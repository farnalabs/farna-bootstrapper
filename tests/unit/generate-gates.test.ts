import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FarnaError } from '../../src/core/errors.js';
import { type FakeMode, FakeRenderTarget } from '../support/fake-renderer.js';
import { createTempRepo, hashTree, readText } from '../support/temp-repo.js';

async function captureFailure(
  repoRoot: string,
  mode: FakeMode,
): Promise<{ error: FarnaError; before: string; after: string }> {
  const before = await hashTree(repoRoot);
  try {
    await runGenerate({ cwd: repoRoot, dryRun: false }, new FakeRenderTarget(mode));
  } catch (error) {
    expect(error).toBeInstanceOf(FarnaError);
    const farna = error as FarnaError;
    return { error: farna, before, after: await hashTree(repoRoot) };
  }
  throw new Error('expected the gate to fail, but generate succeeded');
}

describe('render gates', () => {
  it('T-1: a renderer that drops declared rule text is refused, with zero writes', async () => {
    const repo = await createTempRepo();
    try {
      const { error, before, after } = await captureFailure(repo.root, {
        kind: 'drop-body',
        persona: 'builder',
      });
      expect(error.code).toBe('F008_DECLARED_NOT_EMITTED');
      expect(error.message).toContain('declared rule "house-style"');
      expect(error.subject).toContain('builder.md');
      expect(after).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('T-2: persona content leaking into another persona artefact is refused', async () => {
    const repo = await createTempRepo();
    try {
      const { error, before, after } = await captureFailure(repo.root, {
        kind: 'leak',
        from: 'reviewer',
        into: 'builder',
      });
      expect(error.code).toBe('F008_DECLARED_NOT_EMITTED');
      expect(error.message).toContain('leaked into builder');
      expect(after).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('a renderer that omits a persona file is refused', async () => {
    const repo = await createTempRepo();
    try {
      const { error, before, after } = await captureFailure(repo.root, {
        kind: 'drop-file',
        persona: 'reviewer',
      });
      expect(error.code).toBe('F008_DECLARED_NOT_EMITTED');
      expect(error.message).toContain('declared persona produced no artefact');
      expect(after).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('a renderer that emits an unexpected path is refused', async () => {
    const repo = await createTempRepo();
    try {
      const { error, before, after } = await captureFailure(repo.root, { kind: 'extra-file' });
      expect(error.code).toBe('F008_DECLARED_NOT_EMITTED');
      expect(error.message).toContain('unexpected path');
      expect(error.subject).toBe('.claude/agents/extra.md');
      expect(after).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('a renderer that drops the resolved tools is refused as a permission loss', async () => {
    const repo = await createTempRepo('composed');
    try {
      const { error, before, after } = await captureFailure(repo.root, {
        kind: 'drop-tools',
        persona: 'builder',
      });
      expect(error.code).toBe('F008_DECLARED_NOT_EMITTED');
      expect(error.message).toContain('tools');
      expect(error.subject).toBe('.claude/agents/builder.md');
      expect(after).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('a renderer that drops disallowedTools is refused, including for the reviewer', async () => {
    const repo = await createTempRepo('composed');
    try {
      const { error, before, after } = await captureFailure(repo.root, {
        kind: 'drop-deny',
        persona: 'reviewer',
      });
      expect(error.code).toBe('F008_DECLARED_NOT_EMITTED');
      expect(error.message).toContain('disallowedTools');
      expect(error.subject).toBe('.claude/agents/reviewer.md');
      expect(after).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('a renderer that invents a tools field the persona does not declare is refused', async () => {
    const repo = await createTempRepo();
    try {
      const { error, before, after } = await captureFailure(repo.root, {
        kind: 'invent-tools',
        persona: 'builder',
      });
      expect(error.code).toBe('F008_DECLARED_NOT_EMITTED');
      expect(error.message).toContain('carries "tools"');
      expect(error.subject).toBe('.claude/agents/builder.md');
      expect(after).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('a renderer that swaps two personas permission blocks is refused', async () => {
    const repo = await createTempRepo('composed');
    try {
      const { error, before, after } = await captureFailure(repo.root, {
        kind: 'swap-tools',
        from: 'builder',
        into: 'builder-python',
      });
      expect(error.code).toBe('F008_DECLARED_NOT_EMITTED');
      expect(error.subject).toBe('.claude/agents/builder-python.md');
      expect(after).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('a renderer that appends content after the composed body is refused', async () => {
    const repo = await createTempRepo();
    try {
      const { error, before, after } = await captureFailure(repo.root, {
        kind: 'inject-body',
        persona: 'builder',
        text: 'INJECTED SECRET INSTRUCTION',
      });
      expect(error.code).toBe('F008_DECLARED_NOT_EMITTED');
      expect(error.message).toContain('body');
      expect(after).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('a renderer that emits empty artefacts is refused', async () => {
    const repo = await createTempRepo();
    try {
      const { error, before, after } = await captureFailure(repo.root, { kind: 'empty' });
      expect(error.code).toBe('F008_DECLARED_NOT_EMITTED');
      expect(error.message).toContain('empty');
      expect(after).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('a renderer that lists a path it did not write fails with a typed path error', async () => {
    const repo = await createTempRepo();
    try {
      const { error, before, after } = await captureFailure(repo.root, { kind: 'list-only' });
      expect(error.code).toBe('F008_DECLARED_NOT_EMITTED');
      expect(error.message).toContain('listed a path it did not write');
      expect(error.subject).toBe('.claude/agents/builder.md');
      expect(after).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('accepts a rule whose body legitimately quotes another rule verbatim', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/resources/rules/house-style.md'),
        [
          '---',
          'kind: rule',
          'id: house-style',
          'displayName: House style',
          '---',
          '',
          'FBS_RULE_BUILDER_4a1c',
          '',
          'FBS_RULE_REVIEWER_8d2f',
          '',
          'Read the diff before the summary.',
          '',
          'Report what you could not verify.',
          '',
          'Only then write the summary.',
          '',
        ].join('\n'),
        'utf8',
      );
      const result = await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      expect(result.personas).toEqual(['builder', 'reviewer']);

      const builder = await readText(repo.root, '.claude/agents/builder.md');
      const reviewer = await readText(repo.root, '.claude/agents/reviewer.md');
      expect(builder).toContain('FBS_RULE_BUILDER_4a1c');
      expect(builder).toContain('FBS_RULE_REVIEWER_8d2f');
      expect(reviewer).toContain('FBS_RULE_REVIEWER_8d2f');
    } finally {
      await repo.cleanup();
    }
  });

  it('check applies the same permission-equality gate as generate', async () => {
    const repo = await createTempRepo('composed');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const before = await hashTree(repo.root);
      await expect(
        runCheck(repo.root, new FakeRenderTarget({ kind: 'drop-deny', persona: 'reviewer' })),
      ).rejects.toMatchObject({ code: 'F008_DECLARED_NOT_EMITTED' });
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });
});
