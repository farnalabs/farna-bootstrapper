import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';
import { createTempRepo, readText } from '../support/temp-repo.js';

const AGENT_GOLDEN = new URL('./opencode-v1-builder.md', import.meta.url);
const CONFIG_GOLDEN = new URL('./opencode-v1.jsonc', import.meta.url);
const HOOKS_GOLDEN = new URL('./opencode-v1-hooks.js', import.meta.url);

/**
 * The OpenCode 1.x (`opencodev1`) artefacts, pinned through the real renderer.
 * The agent file pins the V1 per-agent shape (`name`, `description`, `mode`,
 * `model`, the per-tool `permission` map); `opencode.jsonc` pins the flat
 * `mcp.<name>` map with an explicit `enabled: true`; the plugin pins the
 * `RulesyncHooksPlugin` module rather than the V2 `{ id, setup }` object. There
 * is no skip: a missing or broken renderer fails loudly, and the test-count gate
 * asserts every manifest suite ran.
 */
describe('opencodev1 golden output', () => {
  it('renders the builder agent byte for byte', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const actual = await readText(repo.root, '.opencode/agents/builder.md');
      const expected = await readFile(AGENT_GOLDEN, 'utf8');

      expect(actual).toBe(expected);
      expect(actual).toContain('FBS_RULE_BUILDER_4a1c');
      expect(actual).not.toContain('FBS_RULE_REVIEWER_8d2f');
      // OpenCode 1.x keeps the agent name in the file; OpenCode 2.x does not.
      expect(actual).toContain('name: builder');
      // The V1 permission map is a per-tool object, not the V2 ordered array.
      expect(actual).toContain('permission:\n  read:\n');
      expect(actual).not.toContain('permissions:');
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  it('renders the flat V1 opencode.jsonc byte for byte', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const actual = await readText(repo.root, 'opencode.jsonc');
      const expected = await readFile(CONFIG_GOLDEN, 'utf8');

      expect(actual).toBe(expected);
      const parsed = JSON.parse(actual) as { mcp: Record<string, unknown> };
      expect(Object.keys(parsed.mcp)).toEqual(['scan']);
      expect(parsed.mcp).not.toHaveProperty('servers');
      expect(parsed.mcp['scan']).toMatchObject({ enabled: true });
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  it('renders the V1 RulesyncHooksPlugin byte for byte', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const actual = await readText(repo.root, '.opencode/plugins/rulesync-hooks.js');
      const expected = await readFile(HOOKS_GOLDEN, 'utf8');

      expect(actual).toBe(expected);
      expect(actual).toContain('export const RulesyncHooksPlugin');
      expect(actual).toContain('"tool.execute.before"');
      // The V2 plugin's registration surface must not leak into a V1 module.
      expect(actual).not.toContain('export default');
      expect(actual).not.toContain('ctx.tool.hook(');
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  it('is clean immediately after generate, warnings and all', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.exitCode).toBe(0);
      expect(check.target).toBe('opencodev1');
      const codes = check.warnings.map((entry) => entry.code);
      expect(codes).toContain('W112_PERMISSION_LOSSY');
      expect(codes).not.toContain('W101_CAPABILITY_DROPPED');
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});
