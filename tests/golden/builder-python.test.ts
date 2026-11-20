import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';
import { createTempRepo, readText } from '../support/temp-repo.js';

let rulesyncInstalled = true;
try {
  await import('rulesync');
} catch {
  rulesyncInstalled = false;
}

const GOLDEN = new URL('./builder-python.md', import.meta.url);

/**
 * The composed persona's emitted bytes, pinned through the real renderer. A
 * renderer bump that changes the shape of `tools`/`disallowedTools` fails here,
 * which is the intended review event.
 */
describe.skipIf(!rulesyncInstalled)('composed persona golden output', () => {
  it('renders builder-python byte for byte', async () => {
    const repo = await createTempRepo('composed');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const actual = await readText(repo.root, '.claude/agents/builder-python.md');
      const expected = await readFile(GOLDEN, 'utf8');

      expect(actual).toBe(expected);
      expect(actual).toContain('FBS_RULE_BUILDER_4a1c');
      expect(actual).toContain('FBS_RULE_PYTHON_5e3b');
      expect(actual).not.toContain('FBS_RULE_REVIEWER_8d2f');
      expect(actual).toContain('  - Bash\n');
      expect(actual).toContain('  - Task\n');
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  it('is clean immediately after generate, warnings and all', async () => {
    const repo = await createTempRepo('composed');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.exitCode).toBe(0);
      expect(check.warnings.map((entry) => entry.code)).toContain('W112_PERMISSION_LOSSY');
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});
