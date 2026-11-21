import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';
import { createTempRepo, listFiles, readText } from '../support/temp-repo.js';

const AGENT_GOLDEN = new URL('./opencode-builder.md', import.meta.url);

/**
 * The OpenCode artefacts, pinned through the real renderer. The agent file pins
 * the V2 per-agent shape (`description`, `mode`, `model`, ordered
 * `permissions`, no `name`). Agent mode carries no workspace resources, so a
 * source that declares one is refused rather than emitted. There is no skip: a
 * missing or broken renderer fails loudly, and CI asserts that this suite ran.
 */
describe('opencode golden output', () => {
  it('renders the builder agent byte for byte', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const actual = await readText(repo.root, '.opencode/agents/builder.md');
      const expected = await readFile(AGENT_GOLDEN, 'utf8');

      expect(actual).toBe(expected);
      expect(actual).toContain('FBS_RULE_BUILDER_4a1c');
      expect(actual).not.toContain('FBS_RULE_REVIEWER_8d2f');
      expect(actual).not.toContain('name: builder');
      expect(actual).toContain("  - action: subagent\n    resource: '*'\n    effect: deny\n");
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  it('writes no workspace files in agent mode', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const files = await listFiles(repo.root);
      expect(files).not.toContain('opencode.jsonc');
      expect(files.some((path) => path.startsWith('.opencode/commands/'))).toBe(false);
      expect(files.some((path) => path.startsWith('.opencode/skills/'))).toBe(false);
      expect(files.some((path) => path.startsWith('.opencode/plugins/'))).toBe(false);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  it('is clean immediately after generate, warnings and all', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.exitCode).toBe(0);
      const codes = check.warnings.map((entry) => entry.code);
      expect(codes).toContain('W112_PERMISSION_LOSSY');
      expect(codes).not.toContain('W101_CAPABILITY_DROPPED');
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});
