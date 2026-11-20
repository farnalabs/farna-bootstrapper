import { describe, expect, it } from 'vitest';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FarnaError } from '../../src/core/errors.js';
import { type FakeMode, FakeRenderTarget } from '../support/fake-renderer.js';
import { createTempRepo, hashTree } from '../support/temp-repo.js';

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
});
