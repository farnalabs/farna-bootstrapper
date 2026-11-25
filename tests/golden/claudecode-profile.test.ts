import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';
import { createTempRepo, listFiles, readText } from '../support/temp-repo.js';

const GOLDEN_AGENT = new URL('./claudecode-builder.txt', import.meta.url);
const GOLDEN_INSTRUCTIONS = new URL('./claudecode-instructions.txt', import.meta.url);
const GOLDEN_MCP = new URL('./claudecode-mcp.txt', import.meta.url);
const GOLDEN_SETTINGS = new URL('./claudecode-settings.txt', import.meta.url);

/**
 * The user-owned bytes around the four outputs. The region keeps them outside
 * its markers; the two structured files keep their foreign keys. A byte change
 * anywhere this tool does not own would fail the golden.
 */
const USER_INSTRUCTIONS = '# Team notes\n\nSome user prose before the region.\n\n';
const USER_MCP_THEME = 'dark';
const USER_SETTINGS_ALLOW = ['Bash(git status)', 'Read(.env)'];

/**
 * The Claude Code profile's emitted bytes, pinned through the real renderer as
 * `.txt` goldens so the formatter cannot reflow them. A renderer bump that
 * changes an agent key, the instruction body, the MCP server shape or the hooks
 * shape fails here, which is the intended review event. The
 * merge is exercised too: the user prose and the foreign keys are added before
 * the second generate, and the goldens prove they survive byte for byte.
 */
describe('Claude Code profile golden output', () => {
  it('renders the agent file and merges the three owned workspace surfaces', async () => {
    const repo = await createTempRepo('claudecode-profile');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());

      const agent = await readText(repo.root, '.claude/agents/builder.md');
      expect(agent).toBe(await readFile(GOLDEN_AGENT, 'utf8'));
      expect(agent).toContain('FBS_RULE_BUILDER_4a1c');
      expect(agent).not.toContain('FBS_RULE_REVIEWER_8d2f');

      await writeFile(
        join(repo.root, 'CLAUDE.md'),
        USER_INSTRUCTIONS + (await readText(repo.root, 'CLAUDE.md')),
        'utf8',
      );
      const mcp = JSON.parse(await readText(repo.root, '.mcp.json')) as Record<string, unknown>;
      mcp['theme'] = USER_MCP_THEME;
      await writeFile(join(repo.root, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`, 'utf8');
      const settings = JSON.parse(await readText(repo.root, '.claude/settings.json')) as Record<
        string,
        unknown
      >;
      settings['permissions'] = { allow: USER_SETTINGS_ALLOW };
      await writeFile(
        join(repo.root, '.claude/settings.json'),
        `${JSON.stringify(settings, null, 2)}\n`,
        'utf8',
      );

      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());

      expect(await readText(repo.root, 'CLAUDE.md')).toBe(
        await readFile(GOLDEN_INSTRUCTIONS, 'utf8'),
      );
      expect(await readText(repo.root, '.mcp.json')).toBe(await readFile(GOLDEN_MCP, 'utf8'));
      expect(await readText(repo.root, '.claude/settings.json')).toBe(
        await readFile(GOLDEN_SETTINGS, 'utf8'),
      );
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  it('emits exactly the four profile surfaces with the measured top-level keys', async () => {
    const repo = await createTempRepo('claudecode-profile');
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.targets[0]?.mode).toBe('profile');
      expect(result.targets[0]?.activePersona).toBe('builder');
      expect(result.targets[0]?.notLive).toEqual(['reviewer']);
      expect(result.targets[0]?.files.map((file) => file.path)).toEqual([
        '.claude/agents/builder.md',
        '.claude/settings.json',
        '.mcp.json',
        'CLAUDE.md',
      ]);

      // Measured at rulesync 43.14.0: the MCP document carries `mcpServers`
      // and nothing else, and the settings document carries `$schema` beside
      // the `hooks` this tool owns. A renderer upgrade that adds a surface or a
      // key fails here before the design silently carries it.
      const mcp = JSON.parse(await readText(repo.root, '.mcp.json')) as Record<string, unknown>;
      expect(Object.keys(mcp).sort()).toEqual(['mcpServers']);
      const settings = JSON.parse(await readText(repo.root, '.claude/settings.json')) as Record<
        string,
        unknown
      >;
      expect(Object.keys(settings).sort()).toEqual(['$schema', 'hooks']);
      expect(settings['hooks']).toEqual({
        PreToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'command', command: 'pnpm exec prettier --write "$FILE"' }],
          },
        ],
      });
      expect(await listFiles(repo.root)).not.toContain('.claude/agents/reviewer.md');
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});
