import { appendFile, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FarnaError } from '../../src/core/errors.js';
import type { RenderRequest, RenderResult } from '../../src/render/port.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';
import { MutatingRenderTarget, readOutput, writeOutput } from '../support/mutating-renderer.js';
import {
  createEmptyTempDir,
  createTempRepo,
  hashTree,
  listFiles,
  readText,
  type TempRepo,
} from '../support/temp-repo.js';

const skipSymlinks = process.platform === 'win32';

async function generated(fixture = 'opencode'): Promise<TempRepo> {
  const repo = await createTempRepo(fixture);
  await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
  return repo;
}

function frontmatterOf(text: string): Record<string, unknown> {
  const close = text.indexOf('\n---', 4);
  expect(close).toBeGreaterThan(0);
  const document = parseDocument(text.slice(4, close), {
    uniqueKeys: true,
    schema: 'core',
    logLevel: 'silent',
  });
  expect(document.errors).toEqual([]);
  return document.toJS() as Record<string, unknown>;
}

async function expectGate(
  repo: TempRepo,
  mutate: (request: RenderRequest, result: RenderResult) => Promise<RenderResult>,
  message: string,
): Promise<void> {
  const before = await hashTree(repo.root);
  let failure: FarnaError | undefined;
  try {
    await runGenerate({ cwd: repo.root, dryRun: false }, new MutatingRenderTarget(mutate));
  } catch (error) {
    expect(error).toBeInstanceOf(FarnaError);
    failure = error as FarnaError;
  }
  expect(failure?.code).toBe('F008_DECLARED_NOT_EMITTED');
  expect(failure?.message).toContain(message);
  expect(await hashTree(repo.root)).toBe(before);
}

describe('opencode target', () => {
  it('writes exactly the measured OpenCode path set', async () => {
    const repo = await createTempRepo('opencode');
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.target).toBe('opencode');
      expect(result.files.map((file) => file.path)).toEqual([
        '.farna/lock.json',
        '.opencode/agents/builder.md',
        '.opencode/agents/reviewer.md',
        '.opencode/commands/pytest.md',
        '.opencode/plugins/rulesync-hooks.js',
        '.opencode/skills/secure-review/SKILL.md',
        '.opencode/skills/secure-review/scripts/check.sh',
        'opencode.jsonc',
      ]);
      expect(await listFiles(repo.root)).not.toContain('AGENTS.md');
      expect(await listFiles(repo.root)).not.toContain('CLAUDE.md');
    } finally {
      await repo.cleanup();
    }
  });

  it('emits the per-agent frontmatter and the persona body exactly', async () => {
    const repo = await generated();
    try {
      const text = await readText(repo.root, '.opencode/agents/builder.md');
      const frontmatter = frontmatterOf(text);
      expect(Object.keys(frontmatter).sort()).toEqual([
        'description',
        'mode',
        'model',
        'permissions',
      ]);
      expect(frontmatter['mode']).toBe('subagent');
      expect(frontmatter['model']).toBe('anthropic/claude-sonnet-4-5');
      // OpenCode names the agent from the file; a `name` key is V1-only and
      // would make a V2 file be read as V1, so it must be absent.
      expect(frontmatter['name']).toBeUndefined();
      expect(frontmatter['permissions']).toEqual([
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'edit', resource: '*', effect: 'allow' },
        { action: 'shell', resource: '*', effect: 'allow' },
        { action: 'shell', resource: 'git push *', effect: 'deny' },
        { action: 'subagent', resource: '*', effect: 'deny' },
      ]);
      expect(text).toContain('## House style\n\nFBS_RULE_BUILDER_4a1c');
      expect(text).not.toContain('FBS_RULE_REVIEWER_8d2f');
    } finally {
      await repo.cleanup();
    }
  });

  it('keeps persona bodies isolated and writes no shared rule file', async () => {
    const repo = await generated();
    try {
      const builder = await readText(repo.root, '.opencode/agents/builder.md');
      const reviewer = await readText(repo.root, '.opencode/agents/reviewer.md');
      expect(builder).toContain('FBS_RULE_BUILDER_4a1c');
      expect(builder).not.toContain('FBS_RULE_REVIEWER_8d2f');
      expect(reviewer).toContain('FBS_RULE_REVIEWER_8d2f');
      expect(reviewer).not.toContain('FBS_RULE_BUILDER_4a1c');
    } finally {
      await repo.cleanup();
    }
  });

  it('applies MCP, skill, command and hook once at the workspace level', async () => {
    const repo = await generated();
    try {
      const workspace = JSON.parse(await readText(repo.root, 'opencode.jsonc')) as {
        mcp: { servers: Record<string, unknown> };
      };
      expect(Object.keys(workspace.mcp.servers).sort()).toEqual(['docs', 'scan']);
      // Environment references, never values.
      expect(await readText(repo.root, 'opencode.jsonc')).toContain('{env:EXAMPLE_TOKEN}');
      expect(await readText(repo.root, 'opencode.jsonc')).not.toContain('secret-value');
      expect(await readText(repo.root, '.opencode/skills/secure-review/SKILL.md')).toContain(
        'FBS_SKILL_BODY_2b8e',
      );
      expect(
        await readText(repo.root, '.opencode/skills/secure-review/scripts/check.sh'),
      ).toContain('FBS_SKILL_SCRIPT_6c7d');
      expect(await readText(repo.root, '.opencode/commands/pytest.md')).toContain(
        'FBS_COMMAND_BODY_4d6c',
      );
      const plugin = await readText(repo.root, '.opencode/plugins/rulesync-hooks.js');
      expect(plugin).toContain('pnpm exec prettier --write');
      expect(plugin).not.toContain('FBS_HOOK_SESSION_END_9e1f');

      // The reviewer declares none of the workspace resources, so its own
      // artefact must carry no MCP, skill, command or hook key.
      const reviewer = frontmatterOf(await readText(repo.root, '.opencode/agents/reviewer.md'));
      expect(Object.keys(reviewer).sort()).toEqual(['description', 'mode', 'permissions']);
    } finally {
      await repo.cleanup();
    }
  });

  it('warns for every workspace resource kind and for the dropped hook', async () => {
    const repo = await createdWithGenerateWarnings();
    try {
      const byCapability = new Map<string, Array<{ severity: string; message: string }>>();
      for (const entry of repo.warnings) {
        if (entry.code !== 'W101_CAPABILITY_DROPPED') {
          continue;
        }
        const bucket = byCapability.get(entry.capability ?? '') ?? [];
        bucket.push({ severity: entry.severity, message: entry.message });
        byCapability.set(entry.capability ?? '', bucket);
      }
      expect([...byCapability.keys()].sort()).toEqual(['command', 'hook', 'mcp', 'skill']);
      expect(byCapability.get('mcp')?.map((entry) => entry.severity)).toEqual(['high', 'high']);
      expect(byCapability.get('command')?.[0]?.severity).toBe('medium');
      expect(byCapability.get('skill')?.[0]?.severity).toBe('medium');
      const hooks = byCapability.get('hook') ?? [];
      expect(hooks.map((entry) => entry.severity)).toEqual(['high', 'high']);
      expect(hooks.some((entry) => entry.message.includes('hook/format-on-save'))).toBe(true);
      const dropped = hooks.find((entry) => entry.message.includes('session-audit'));
      expect(dropped?.message).toContain('session-end');
      expect(dropped?.message).toContain('not emitted');
      for (const messages of byCapability.values()) {
        for (const entry of messages) {
          expect(entry.message).toContain('builder');
        }
      }
      // W112 is the widening case only: builder's write allow has no edit
      // declaration. The reviewer declares write deny, which narrows, so it
      // must not be presented as a loss.
      expect(repo.warnings.filter((entry) => entry.code === 'W112_PERMISSION_LOSSY')).toHaveLength(
        1,
      );
      expect(repo.warnings.filter((entry) => entry.code === 'W111_ASK_DOWNGRADED')).toHaveLength(1);
    } finally {
      await repo.cleanup();
    }
  });

  it('records the target, the managed files and the source warnings in the lockfile', async () => {
    const repo = await generated();
    try {
      const lock = JSON.parse(await readText(repo.root, '.farna/lock.json')) as {
        target: string;
        files: Array<{ path: string; sha256: string; size: number }>;
        personas: Array<{ id: string; resources: Array<{ kind: string; id: string }> }>;
        warnings: Array<{ code: string; capability?: string; message: string }>;
      };
      expect(lock.target).toBe('opencode');
      expect(lock.files.map((file) => file.path)).toEqual([
        '.opencode/agents/builder.md',
        '.opencode/agents/reviewer.md',
        '.opencode/commands/pytest.md',
        '.opencode/plugins/rulesync-hooks.js',
        '.opencode/skills/secure-review/SKILL.md',
        '.opencode/skills/secure-review/scripts/check.sh',
        'opencode.jsonc',
      ]);
      expect(lock.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
      expect(
        lock.personas[0]?.resources.map((resource) => `${resource.kind}/${resource.id}`),
      ).toEqual([
        'rule/house-style',
        'permission/builder-default',
        'mcp/docs',
        'mcp/scan',
        'skill/secure-review',
        'command/pytest',
        'hook/format-on-save',
        'hook/session-audit',
      ]);
      const codes = lock.warnings.map((entry) => entry.code);
      expect(codes).toContain('W101_CAPABILITY_DROPPED');
      expect(codes).not.toContain('W114_RENDERER_INTEGRITY_UNVERIFIED');
      expect(lock.warnings.some((entry) => entry.message.includes('session-audit'))).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('is idempotent and checks clean immediately after generate', async () => {
    const repo = await generated();
    try {
      const before = await hashTree(repo.root);
      const again = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(again.files.every((file) => file.status === 'unchanged')).toBe(true);
      expect(await hashTree(repo.root)).toBe(before);

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.exitCode).toBe(0);
      expect(check.warnings.map((entry) => entry.code)).toContain('W101_CAPABILITY_DROPPED');
    } finally {
      await repo.cleanup();
    }
  });

  it('detects drift in an agent file, the workspace config and a skill file', async () => {
    const repo = await generated();
    try {
      const agent = await readFile(join(repo.root, '.opencode/agents/builder.md'), 'utf8');
      await appendFile(join(repo.root, '.opencode/agents/builder.md'), '\nmanual\n', 'utf8');
      let check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(false);
      expect(check.drift.map((item) => item.path)).toContain('.opencode/agents/builder.md');
      await writeFile(join(repo.root, '.opencode/agents/builder.md'), agent, 'utf8');

      const config = await readFile(join(repo.root, 'opencode.jsonc'), 'utf8');
      await writeFile(join(repo.root, 'opencode.jsonc'), `${config} `, 'utf8');
      check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.drift.map((item) => item.path)).toContain('opencode.jsonc');
      await writeFile(join(repo.root, 'opencode.jsonc'), config, 'utf8');

      const skill = await readFile(
        join(repo.root, '.opencode/skills/secure-review/scripts/check.sh'),
        'utf8',
      );
      await writeFile(
        join(repo.root, '.opencode/skills/secure-review/scripts/check.sh'),
        `${skill}# manual\n`,
        'utf8',
      );
      check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.drift.map((item) => item.path)).toContain(
        '.opencode/skills/secure-review/scripts/check.sh',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('reports a missing managed file and a stray file at any depth', async () => {
    const repo = await generated();
    try {
      const command = await readFile(join(repo.root, '.opencode/commands/pytest.md'), 'utf8');
      await rm(join(repo.root, '.opencode/commands/pytest.md'));
      let check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.drift.map((item) => [item.path, item.kind])).toEqual([
        ['.opencode/commands/pytest.md', 'missing'],
      ]);
      await writeFile(join(repo.root, '.opencode/commands/pytest.md'), command, 'utf8');

      await writeFile(
        join(repo.root, '.opencode/skills/secure-review/extra.md'),
        'stray\n',
        'utf8',
      );
      check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.drift.map((item) => [item.path, item.kind])).toEqual([
        ['.opencode/skills/secure-review/extra.md', 'unexpected'],
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('binds each hook matcher to its own registration', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/hooks/audit-tool.jsonc'),
        JSON.stringify(
          {
            kind: 'hook',
            id: 'audit-tool',
            phase: 'before-tool',
            command: 'echo FBS_HOOK_AUDIT_1a2b',
          },
          null,
          2,
        ),
        'utf8',
      );
      await appendFile(
        join(repo.root, '.farna/personas/builder.yaml'),
        '  - hook/audit-tool\n',
        'utf8',
      );
      // The second before-tool hook carries no matcher. A containment check
      // that scanned backwards instead of at the registration block would
      // inherit the first hook's matcher and refuse a valid plugin.
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const plugin = await readText(repo.root, '.opencode/plugins/rulesync-hooks.js');
      expect(plugin).toContain('FBS_HOOK_AUDIT_1a2b');
      expect(plugin).toContain('new RegExp("Edit|Write")');
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('generates a persona with no rules or permissions', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await writeFile(
        join(repo.root, '.farna/personas/empty.yaml'),
        'kind: persona\nid: empty\ndisplayName: Empty\npurpose: A persona with no rules.\nresources: []\n',
        'utf8',
      );
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const text = await readText(repo.root, '.opencode/agents/empty.md');
      const frontmatter = frontmatterOf(text);
      expect(Object.keys(frontmatter).sort()).toEqual(['description', 'mode']);
      expect(frontmatter['mode']).toBe('subagent');
      // The honest renderer emits no body when there are no rules.
      expect(text.endsWith('---\n')).toBe(true);
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses two configured targets rather than silently picking one', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await writeFile(
        join(repo.root, '.farna/config.jsonc'),
        '{"schemaVersion":1,"targets":{"claudecode":{},"opencode":{}}}\n',
        'utf8',
      );
      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
      ).rejects.toMatchObject({ code: 'F001_INVALID_CONFIG' });
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a tool allow-list opt-in OpenCode cannot express', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/permissions/review-only.jsonc'),
        JSON.stringify(
          {
            kind: 'permission',
            id: 'review-only',
            allowlist: true,
            tools: { read: 'allow' },
          },
          null,
          2,
        ),
        'utf8',
      );
      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
      ).rejects.toMatchObject({ code: 'F001_INVALID_CONFIG' });
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a literal MCP credential and never echoes it', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/mcp/leaky.jsonc'),
        JSON.stringify(
          {
            kind: 'mcp',
            id: 'leaky',
            server: {
              type: 'stdio',
              command: 'npx',
              env: { EXAMPLE_TOKEN: 'super-secret-literal-value' },
            },
          },
          null,
          2,
        ),
        'utf8',
      );
      await appendFile(join(repo.root, '.farna/personas/reviewer.yaml'), '  - mcp/leaky\n', 'utf8');
      let failure: FarnaError | undefined;
      try {
        await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      } catch (error) {
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F002_SECRET_LITERAL');
      expect(failure?.message).not.toContain('super-secret-literal-value');
    } finally {
      await repo.cleanup();
    }
  });

  it('drops a hook whose matcher the target cannot honour', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/hooks/start-matched.jsonc'),
        JSON.stringify(
          {
            kind: 'hook',
            id: 'start-matched',
            phase: 'session-start',
            matcher: 'Edit',
            command: 'echo start',
          },
          null,
          2,
        ),
        'utf8',
      );
      await appendFile(
        join(repo.root, '.farna/personas/builder.yaml'),
        '  - hook/start-matched\n',
        'utf8',
      );
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      const dropped = result.warnings.find(
        (entry) =>
          entry.code === 'W101_CAPABILITY_DROPPED' && entry.message.includes('start-matched'),
      );
      expect(dropped?.message).toContain('matcher on tool events only');
      const plugin = await readText(repo.root, '.opencode/plugins/rulesync-hooks.js');
      expect(plugin).not.toContain('echo start');
    } finally {
      await repo.cleanup();
    }
  });
});

async function createdWithGenerateWarnings(): Promise<
  TempRepo & { warnings: Awaited<ReturnType<typeof runGenerate>>['warnings'] }
> {
  const repo = await createTempRepo('opencode');
  const result = await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
  return { ...repo, warnings: result.warnings };
}

describe('opencode containment gates', () => {
  it('refuses a changed permission record', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await expectGate(
        repo,
        async (request, result) => {
          const text = await readOutput(request.outputRoot, '.opencode/agents/builder.md');
          await writeOutput(
            request.outputRoot,
            '.opencode/agents/builder.md',
            text.replace('effect: allow', 'effect: deny'),
          );
          return result;
        },
        'permissions',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses an undeclared frontmatter key', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await expectGate(
        repo,
        async (request, result) => {
          const text = await readOutput(request.outputRoot, '.opencode/agents/builder.md');
          await writeOutput(
            request.outputRoot,
            '.opencode/agents/builder.md',
            text.replace('---\n', '---\nname: builder\n'),
          );
          return result;
        },
        'undeclared key "name"',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses another persona body leaked into an agent', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await expectGate(
        repo,
        async (request, result) => {
          const text = await readOutput(request.outputRoot, '.opencode/agents/builder.md');
          await writeOutput(
            request.outputRoot,
            '.opencode/agents/builder.md',
            `${text}\n## Review checklist\n\nFBS_RULE_REVIEWER_8d2f Report what you could not verify.\n`,
          );
          return result;
        },
        'leaked into builder',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a dropped MCP server in the workspace config', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await expectGate(
        repo,
        async (request, result) => {
          const config = JSON.parse(await readOutput(request.outputRoot, 'opencode.jsonc')) as {
            mcp: { servers: Record<string, unknown> };
          };
          delete config.mcp.servers['scan'];
          await writeOutput(request.outputRoot, 'opencode.jsonc', JSON.stringify(config, null, 2));
          return result;
        },
        'mcp servers',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses an injected hook command', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await expectGate(
        repo,
        async (request, result) => {
          const plugin = await readOutput(
            request.outputRoot,
            '.opencode/plugins/rulesync-hooks.js',
          );
          await writeOutput(
            request.outputRoot,
            '.opencode/plugins/rulesync-hooks.js',
            `${plugin}\n__rulesyncRunHook({ label: "preToolUse", command: "echo INJECTED", input: "", blocking: false, seconds: 600 });\n`,
          );
          return result;
        },
        'hooks plugin registers',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a dropped skill file', async () => {
    const repo = await createTempRepo('opencode');
    const path = '.opencode/skills/secure-review/scripts/check.sh';
    try {
      await expectGate(
        repo,
        async (request, result) => {
          await rm(join(request.outputRoot, path));
          return { ...result, files: result.files.filter((file) => file !== path) };
        },
        'declared resource produced no artefact',
      );
    } finally {
      await repo.cleanup();
    }
  });
});

describe('opencode path guards', () => {
  it.skipIf(skipSymlinks)('refuses a symlinked .opencode directory on generate', async () => {
    const repo = await createTempRepo('opencode');
    const outside = await createEmptyTempDir();
    try {
      await symlink(outside.root, join(repo.root, '.opencode'), 'dir');
      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
      ).rejects.toMatchObject({ code: 'F003_PATH_UNSAFE' });
      await expect(
        runGenerate({ cwd: repo.root, dryRun: true }, new UpstreamRenderTarget()),
      ).rejects.toMatchObject({ code: 'F003_PATH_UNSAFE' });
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });

  it.skipIf(skipSymlinks)('refuses a symlinked managed agent file on generate', async () => {
    const repo = await generated();
    const outside = await createEmptyTempDir();
    try {
      const victim = join(outside.root, 'victim.md');
      await writeFile(victim, 'victim\n', 'utf8');
      const path = join(repo.root, '.opencode/agents/builder.md');
      await rm(path);
      await symlink(victim, path, 'file');
      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
      ).rejects.toMatchObject({ code: 'F003_PATH_UNSAFE' });
      expect(await readFile(victim, 'utf8')).toBe('victim\n');
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });

  it.skipIf(skipSymlinks)('reports a symlinked managed file as drift', async () => {
    const repo = await generated();
    const outside = await createEmptyTempDir();
    try {
      const victim = join(outside.root, 'victim.md');
      await writeFile(victim, 'victim\n', 'utf8');
      const path = join(repo.root, '.opencode/commands/pytest.md');
      await rm(path);
      await symlink(victim, path, 'file');
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(false);
      expect(check.drift).toEqual([
        {
          code: 'F007_DRIFT',
          path: '.opencode/commands/pytest.md',
          kind: 'modified',
          detail: 'managed path is not a regular file',
        },
      ]);
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });
});
