import { describe, expect, it, vi } from 'vitest';

/**
 * One read per artefact. `verifyRender` must return the exact bytes it checked
 * and `prepareRender` must write those bytes; a second read of the stage would
 * let the committed bytes differ from the verified ones (the TOCTOU the old
 * implementation had between verification and capture).
 *
 * The read log is the observation: the stage artefacts live under `out/`, so a
 * second read of `/out/.claude/agents/<persona>.md` is visible here without
 * mocking the renderer. Reads go through the bounded byte reader, which opens
 * the path and reads from the handle, so `open` is what is recorded.
 */
const reads = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (async (path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string') {
        reads.push(path);
      }
      return await (actual.open as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof actual.open,
  };
});

const { runGenerate } = await import('../../src/cli/commands/generate.js');
const { FakeRenderTarget } = await import('../support/fake-renderer.js');
const { createTempRepo } = await import('../support/temp-repo.js');

describe('verified bytes are the committed bytes', () => {
  it('reads each rendered artefact once during generate', async () => {
    const repo = await createTempRepo();
    try {
      reads.length = 0;
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const stageReads = reads.filter(
        (path) => path.includes(`${'/'}out/.claude/agents/`) || path.includes('\\out\\'),
      );
      expect(stageReads).toHaveLength(2);
      // Two personas, one stage read each, and no second read for the capture.
      expect(stageReads.filter((path) => path.endsWith('builder.md'))).toHaveLength(1);
      expect(stageReads.filter((path) => path.endsWith('reviewer.md'))).toHaveLength(1);
    } finally {
      await repo.cleanup();
    }
  });
});
