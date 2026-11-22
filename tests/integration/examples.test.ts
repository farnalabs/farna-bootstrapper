import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');

type Run = { code: number; stdout: string; stderr: string };

/**
 * Run the built CLI in a working directory. The examples are only real if the
 * shipped entry point renders them and `check` accepts the result, so this
 * drives `dist/cli/main.js`, not the command modules directly.
 */
async function run(cwd: string, args: string[]): Promise<Run> {
  try {
    const result = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd,
      timeout: 120_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/** Copy one example into a fresh directory so its generated output never lands here. */
async function copyExample(name: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `fbs-example-${name}-`));
  await cp(join(ROOT, 'examples', name), root, { recursive: true });
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('the shipped examples', () => {
  it('renders the Claude Code example and passes check from its own directory', async () => {
    const example = await copyExample('claude-code');
    try {
      const generate = await run(example.root, ['generate']);
      expect(generate.code, generate.stderr).toBe(0);
      expect(generate.stdout).toContain('target claudecode (agent mode)');
      expect(existsSync(join(example.root, '.claude/agents/builder.md'))).toBe(true);
      expect(existsSync(join(example.root, '.claude/agents/reviewer.md'))).toBe(true);
      expect(existsSync(join(example.root, '.farna/lock.json'))).toBe(true);

      // The reviewer's restriction is emitted, not merely promised in prose:
      // every mutating category reaches the exact Claude Code tool name.
      const reviewer = await readFile(join(example.root, '.claude/agents/reviewer.md'), 'utf8');
      const disallowed = reviewer.slice(reviewer.indexOf('disallowedTools:'));
      for (const tool of ['Agent', 'Bash', 'Edit', 'Write']) {
        expect(disallowed).toContain(`  - ${tool}\n`);
      }

      const check = await run(example.root, ['check']);
      expect(check.code, check.stderr).toBe(0);
      expect(check.stdout).toContain('check: clean');
    } finally {
      await example.cleanup();
    }
  });

  it('reports drift in the Claude Code example after a hand edit', async () => {
    const example = await copyExample('claude-code');
    try {
      expect((await run(example.root, ['generate'])).code).toBe(0);
      const builder = join(example.root, '.claude/agents/builder.md');
      await writeFile(builder, `${await readFile(builder, 'utf8')} `, 'utf8');

      const check = await run(example.root, ['check']);
      expect(check.code).toBe(1);
      expect(check.stdout).toContain('.claude/agents/builder.md');
      expect(check.stdout).toContain('check: drift');
    } finally {
      await example.cleanup();
    }
  });

  it('renders the OpenCode 2.x profile example with one live persona and passes check', async () => {
    const example = await copyExample('opencode-v2');
    try {
      const generate = await run(example.root, ['generate']);
      expect(generate.code, generate.stderr).toBe(0);
      expect(generate.stdout).toContain('target opencode (profile mode, active builder)');
      expect(generate.stdout).toContain('not live reviewer');
      expect(existsSync(join(example.root, 'opencode.jsonc'))).toBe(true);
      expect(existsSync(join(example.root, '.opencode/agents/builder.md'))).toBe(true);
      expect(existsSync(join(example.root, '.opencode/skills/release-check/SKILL.md'))).toBe(true);
      expect(existsSync(join(example.root, '.opencode/commands/run-tests.md'))).toBe(true);
      expect(existsSync(join(example.root, '.opencode/plugins/rulesync-hooks.js'))).toBe(true);
      // The invariant is one persona per workspace: the inactive persona is not emitted.
      expect(existsSync(join(example.root, '.opencode/agents/reviewer.md'))).toBe(false);

      const workspace = await readFile(join(example.root, 'opencode.jsonc'), 'utf8');
      expect(workspace).toContain('DOCS_TOKEN');

      // The example's declared hook command reaches the emitted plugin. It is
      // local and self-contained: no `npx` package fetch and no undefined
      // `$FILE` variable.
      const plugin = await readFile(
        join(example.root, '.opencode/plugins/rulesync-hooks.js'),
        'utf8',
      );
      expect(plugin).toContain('farna-bootstrapper: session started');
      expect(plugin).not.toContain('prettier');

      const check = await run(example.root, ['check']);
      expect(check.code, check.stderr).toBe(0);
      expect(check.stdout).toContain('check: clean');
    } finally {
      await example.cleanup();
    }
  });

  it('renders the OpenCode 1.x profile example with the V1 shapes and passes check', async () => {
    const example = await copyExample('opencode-v1');
    try {
      const generate = await run(example.root, ['generate']);
      expect(generate.code, generate.stderr).toBe(0);
      expect(generate.stdout).toContain('target opencodev1 (profile mode, active builder)');
      expect(generate.stdout).toContain('not live reviewer');
      expect(existsSync(join(example.root, 'opencode.jsonc'))).toBe(true);
      expect(existsSync(join(example.root, '.opencode/agents/builder.md'))).toBe(true);
      expect(existsSync(join(example.root, '.opencode/skills/release-check/SKILL.md'))).toBe(true);
      expect(existsSync(join(example.root, '.opencode/commands/run-tests.md'))).toBe(true);
      expect(existsSync(join(example.root, '.opencode/plugins/rulesync-hooks.js'))).toBe(true);
      expect(existsSync(join(example.root, '.opencode/agents/reviewer.md'))).toBe(false);

      const agent = await readFile(join(example.root, '.opencode/agents/builder.md'), 'utf8');
      expect(agent).toContain('name: builder');
      expect(agent).toContain('permission:');
      const workspace = (await readFile(join(example.root, 'opencode.jsonc'), 'utf8')).trim();
      const mcp = JSON.parse(workspace) as { mcp: Record<string, unknown> };
      expect(Object.keys(mcp.mcp)).toEqual(['docs']);
      expect(mcp.mcp).not.toHaveProperty('servers');
      const plugin = await readFile(
        join(example.root, '.opencode/plugins/rulesync-hooks.js'),
        'utf8',
      );
      expect(plugin).toContain('export const RulesyncHooksPlugin');
      expect(plugin).toContain('farna-bootstrapper: session started');
      expect(plugin).not.toContain('prettier');

      const check = await run(example.root, ['check']);
      expect(check.code, check.stderr).toBe(0);
      expect(check.stdout).toContain('check: clean');
    } finally {
      await example.cleanup();
    }
  });
});
