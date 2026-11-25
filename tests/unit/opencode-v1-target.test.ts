import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FarnaError } from '../../src/core/errors.js';
import { parseJsonc } from '../../src/core/json.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';
import { MutatingRenderTarget, readOutput, writeOutput } from '../support/mutating-renderer.js';
import {
  createTempRepo,
  hashTree,
  listFiles,
  readText,
  type TempRepo,
} from '../support/temp-repo.js';

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

async function generated(fixture: string, persona?: string): Promise<TempRepo> {
  const repo = await createTempRepo(fixture);
  await runGenerate(
    { cwd: repo.root, dryRun: false, ...(persona === undefined ? {} : { persona }) },
    new UpstreamRenderTarget(),
  );
  return repo;
}

/** Point the committed config at one OpenCode target, leaving the rest alone. */
async function setTarget(repo: TempRepo, target: 'opencode' | 'opencodev1'): Promise<void> {
  const path = join(repo.root, '.farna/config.jsonc');
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace(/"(?:opencode|opencodev1)":/g, `"${target}":`), 'utf8');
}

type LockTargetShape = {
  mode: string;
  activePersona: string | null;
  files: Array<{ path: string }>;
};

type LockShape = {
  targets: Record<string, LockTargetShape>;
  warnings: Array<{ code: string }>;
};

async function lockOf(repo: TempRepo): Promise<LockShape> {
  return JSON.parse(await readText(repo.root, '.farna/lock.json')) as LockShape;
}

async function jsonOf(repo: TempRepo, path: string): Promise<Record<string, unknown>> {
  return parseJsonc<Record<string, unknown>>(await readText(repo.root, path), { subject: path });
}

async function expectFailure(run: () => Promise<unknown>, code: string): Promise<FarnaError> {
  let failure: FarnaError | undefined;
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(FarnaError);
    failure = error as FarnaError;
  }
  expect(failure?.code).toBe(code);
  return failure as FarnaError;
}

describe('opencodev1 target identity', () => {
  it('writes the same measured path set as the V2 target and records itself in the lockfile', async () => {
    const repo = await generated('profile-v1');
    try {
      expect(Object.keys((await lockOf(repo)).targets)).toEqual(['opencodev1']);
      const files = (await listFiles(repo.root)).filter(
        (path) =>
          path.startsWith('.opencode/') || path === 'opencode.jsonc' || path === '.farna/lock.json',
      );
      expect(files).toEqual([
        '.farna/lock.json',
        '.opencode/agents/builder.md',
        '.opencode/commands/pytest.md',
        '.opencode/plugins/rulesync-hooks.js',
        '.opencode/skills/secure-review/SKILL.md',
        '.opencode/skills/secure-review/scripts/check.sh',
        'opencode.jsonc',
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses opencode and opencodev1 configured in one run', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      const path = join(repo.root, '.farna/config.jsonc');
      const text = await readFile(path, 'utf8');
      await writeFile(
        path,
        text.replace('"targets": {', '"targets": {\n    "opencode": {},'),
        'utf8',
      );
      const before = await hashTree(repo.root);
      const failure = await expectFailure(
        () => runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
        'F001_INVALID_CONFIG',
      );
      expect(failure.message).toContain('exactly one configured target');
      expect(failure.message).toContain('opencodev1');
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a model class with no opencodev1 mapping', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      const path = join(repo.root, '.farna/config.jsonc');
      const text = await readFile(path, 'utf8');
      await writeFile(
        path,
        text.replace('"opencodev1": "anthropic/claude-sonnet-4-5"', ''),
        'utf8',
      );
      const failure = await expectFailure(
        () => runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
        'F001_INVALID_CONFIG',
      );
      expect(failure.message).toContain('opencodev1');
    } finally {
      await repo.cleanup();
    }
  });
});

describe('opencodev1 per-agent file', () => {
  it('emits the V1 key set with name and the per-tool permission map', async () => {
    const repo = await generated('profile-v1');
    try {
      const text = await readText(repo.root, '.opencode/agents/builder.md');
      const frontmatter = frontmatterOf(text);
      expect(Object.keys(frontmatter).sort()).toEqual([
        'description',
        'mode',
        'model',
        'name',
        'permission',
      ]);
      expect(frontmatter['name']).toBe('builder');
      expect(frontmatter['mode']).toBe('subagent');
      expect(frontmatter['model']).toBe('anthropic/claude-sonnet-4-5');
      expect(frontmatter['permission']).toEqual({
        read: { '*': 'allow' },
        // `write` folds into `edit`; OpenCode has no write category.
        edit: { '*': 'allow' },
        // `shell` is named `bash` in OpenCode's own map.
        bash: { '*': 'allow', 'git push *': 'deny' },
        // `ask` is downgraded to deny on both OpenCode targets (W111).
        task: { '*': 'deny' },
      });
      expect(frontmatter['permissions']).toBeUndefined();
      expect(text).toContain('## House style\n\nFBS_RULE_BUILDER_4a1c');
      expect(text).not.toContain('FBS_RULE_REVIEWER_8d2f');
    } finally {
      await repo.cleanup();
    }
  });
});

describe('opencodev1 workspace files', () => {
  it('emits the flat mcp map, not the V2 servers envelope', async () => {
    const repo = await generated('profile-v1');
    try {
      const config = (await jsonOf(repo, 'opencode.jsonc')) as {
        mcp: Record<string, Record<string, unknown>>;
      };
      expect(Object.keys(config.mcp)).toEqual(['scan']);
      expect(config.mcp).not.toHaveProperty('servers');
      expect(config.mcp['scan']).toEqual({
        type: 'local',
        command: ['npx', '-y', 'example-security-mcp'],
        enabled: true,
        environment: { EXAMPLE_TOKEN: '{env:EXAMPLE_TOKEN}' },
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('emits a V1 command frontmatter and a V1 plugin module', async () => {
    const repo = await generated('profile-v1');
    try {
      const command = await readText(repo.root, '.opencode/commands/pytest.md');
      expect(Object.keys(frontmatterOf(command))).toEqual(['description']);
      expect(command).toContain('FBS_COMMAND_BODY_4d6c');

      const plugin = await readText(repo.root, '.opencode/plugins/rulesync-hooks.js');
      expect(plugin).toContain('export const RulesyncHooksPlugin');
      expect(plugin).toContain('"tool.execute.before"');
      expect(plugin).toContain('new RegExp("^(?:edit|write)$")');
      expect(plugin).toContain('pnpm exec prettier');
      expect(plugin).not.toContain('export default');
    } finally {
      await repo.cleanup();
    }
  });
});

describe('opencodev1 profile mode', () => {
  it('carries rules, permissions, MCP, a skill, a command and a hook with no leakage', async () => {
    const repo = await generated('profile-v1');
    try {
      const files = await listFiles(repo.root);
      expect(files).toContain('.opencode/skills/secure-review/SKILL.md');
      expect(files).toContain('.opencode/skills/secure-review/scripts/check.sh');
      expect(files).toContain('.opencode/commands/pytest.md');
      expect(files).toContain('.opencode/plugins/rulesync-hooks.js');
      // The inactive persona is resolved but not emitted, and its workspace
      // resources must not leak into the builder's workspace.
      expect(files).not.toContain('.opencode/agents/reviewer.md');
      expect(files).not.toContain('.opencode/commands/review-triage.md');
      const config = (await jsonOf(repo, 'opencode.jsonc')) as { mcp: Record<string, unknown> };
      expect(config.mcp).not.toHaveProperty('docs');
      const skill = await readText(repo.root, '.opencode/skills/secure-review/SKILL.md');
      expect(skill).toContain('FBS_SKILL_BODY_2b8e');

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.targets[0]?.mode).toBe('profile');
      expect(check.targets[0]?.activePersona).toBe('builder');
      expect(check.warnings.map((entry) => entry.code)).not.toContain('W101_CAPABILITY_DROPPED');
    } finally {
      await repo.cleanup();
    }
  });

  it('switches persona, removes the previous persona output and checks clean', async () => {
    const repo = await generated('profile-v1');
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false, persona: 'reviewer' },
        new UpstreamRenderTarget(),
      );
      expect(result.targets[0]?.activePersona).toBe('reviewer');
      expect(result.targets[0]?.removed.map((entry) => entry.path).sort()).toEqual([
        '.opencode/agents/builder.md',
        '.opencode/commands/pytest.md',
        '.opencode/plugins/rulesync-hooks.js',
        '.opencode/skills/secure-review/SKILL.md',
        '.opencode/skills/secure-review/scripts/check.sh',
      ]);
      expect(result.targets[0]?.removed.every((entry) => entry.status === 'removed')).toBe(true);

      const files = await listFiles(repo.root);
      expect(files).toContain('.opencode/agents/reviewer.md');
      expect(files).toContain('.opencode/commands/review-triage.md');
      expect(files).not.toContain('.opencode/agents/builder.md');
      expect(files).not.toContain('.opencode/plugins/rulesync-hooks.js');
      const config = (await jsonOf(repo, 'opencode.jsonc')) as { mcp: Record<string, unknown> };
      expect(Object.keys(config.mcp)).toEqual(['docs']);

      const lock = await lockOf(repo);
      expect(Object.values(lock.targets)[0]?.activePersona).toBe('reviewer');
      // `--persona` is an override, never written back, so `check` needs it too.
      expect(
        (await runCheck(repo.root, new UpstreamRenderTarget(), { persona: 'reviewer' })).ok,
      ).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a workspace resource in agent mode and names the V1 target', async () => {
    const repo = await createTempRepo('opencode-v1');
    try {
      await appendFile(join(repo.root, '.farna/personas/builder.yaml'), '  - mcp/scan\n', 'utf8');
      const before = await hashTree(repo.root);
      const failure = await expectFailure(
        () => runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
        'F001_INVALID_CONFIG',
      );
      expect(failure.message).toContain('mcp/scan');
      expect(failure.message).toContain('requires profile mode');
      expect(failure.action).toContain('targets.opencodev1.active');
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });
});

describe('opencodev1 permission mapping and refusals', () => {
  it('refuses an unmappable category with F011', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/permissions/builder-default.jsonc'),
        `${JSON.stringify(
          { kind: 'permission', id: 'builder-default', tools: { network: 'allow' } },
          null,
          2,
        )}\n`,
        'utf8',
      );
      const before = await hashTree(repo.root);
      const failure = await expectFailure(
        () => runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
        'F011_PERMISSION_UNMAPPED',
      );
      expect(failure.message).toContain('network');
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a Claude Code tool allow-list, which neither OpenCode target can express', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/permissions/builder-default.jsonc'),
        `${JSON.stringify(
          {
            kind: 'permission',
            id: 'builder-default',
            tools: { read: 'allow' },
            allowlist: true,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      const failure = await expectFailure(
        () => runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
        'F001_INVALID_CONFIG',
      );
      expect(failure.message).toContain('allow-list');
    } finally {
      await repo.cleanup();
    }
  });
});

describe('opencodev1 and opencode v2 share paths', () => {
  it('rewrites the recorded V1 paths when switching to V2 and back, orphaning nothing', async () => {
    const repo = await generated('profile-v1');
    try {
      const v1 = await lockOf(repo);
      const v1Paths = Object.values(v1.targets)[0]?.files.map((file) => file.path) ?? [];

      await setTarget(repo, 'opencode');
      const toV2 = await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      expect(toV2.targets[0]?.target).toBe('opencode');
      expect(toV2.targets[0]?.removed).toEqual([]);
      const v2Lock = await lockOf(repo);
      expect(Object.values(v2Lock.targets)[0]?.files.map((file) => file.path)).toEqual(v1Paths);
      expect(Object.keys(v2Lock.targets)).toEqual(['opencode']);
      const v2Agent = frontmatterOf(await readText(repo.root, '.opencode/agents/builder.md'));
      expect(v2Agent['name']).toBeUndefined();
      expect(v2Agent['permissions']).toBeDefined();
      const v2Config = await jsonOf(repo, 'opencode.jsonc');
      expect(Object.keys(v2Config['mcp'] as Record<string, unknown>)).toEqual(['servers']);
      expect((await runCheck(repo.root, new UpstreamRenderTarget())).ok).toBe(true);

      await setTarget(repo, 'opencodev1');
      const backToV1 = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(backToV1.targets[0]?.target).toBe('opencodev1');
      expect(backToV1.targets[0]?.removed).toEqual([]);
      expect(
        Object.values((await lockOf(repo)).targets)[0]?.files.map((file) => file.path),
      ).toEqual(v1Paths);
      const v1Agent = frontmatterOf(await readText(repo.root, '.opencode/agents/builder.md'));
      expect(v1Agent['name']).toBe('builder');
      expect(v1Agent['permission']).toBeDefined();
      expect(v1Agent['permissions']).toBeUndefined();
      const v1Config = (await jsonOf(repo, 'opencode.jsonc')) as { mcp: Record<string, unknown> };
      expect(Object.keys(v1Config.mcp)).toEqual(['scan']);
      expect((await runCheck(repo.root, new UpstreamRenderTarget())).ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("preserves the user's foreign keys and comments around the owned V1 mcp key", async () => {
    const repo = await generated('profile-v1');
    try {
      const current = await readText(repo.root, 'opencode.jsonc');
      const mcp = JSON.stringify((JSON.parse(current) as { mcp: unknown }).mcp, null, 2).replaceAll(
        '\n',
        '\n  ',
      );
      await writeFile(
        join(repo.root, 'opencode.jsonc'),
        [
          "// the user's own header comment",
          '{',
          '  // their theme, their comment',
          '  "theme": "dark",',
          '  "$schema": "https://example.test/opencode.schema.json",',
          `  "mcp": ${mcp}`,
          '}',
          '',
        ].join('\n'),
        'utf8',
      );

      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const merged = await readText(repo.root, 'opencode.jsonc');
      expect(merged).toContain("// the user's own header comment");
      expect(merged).toContain('"theme": "dark"');
      const parsed = (await jsonOf(repo, 'opencode.jsonc')) as {
        mcp: Record<string, Record<string, unknown>>;
        theme: string;
      };
      expect(parsed.theme).toBe('dark');
      expect(Object.keys(parsed.mcp)).toEqual(['scan']);
      expect(parsed.mcp['scan']?.['enabled']).toBe(true);
      expect((await runCheck(repo.root, new UpstreamRenderTarget())).ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

/** Run generate with the real renderer's output mutated; assert nothing was written. */
async function expectV1Gate(
  repo: TempRepo,
  mutate: (outputRoot: string) => Promise<void>,
  message: string,
): Promise<void> {
  const before = await hashTree(repo.root);
  const failure = await expectFailure(
    () =>
      runGenerate(
        { cwd: repo.root, dryRun: false },
        new MutatingRenderTarget(async (request, result) => {
          await mutate(request.outputRoot);
          return result;
        }),
      ),
    'F008_DECLARED_NOT_EMITTED',
  );
  expect(failure.message).toContain(message);
  expect(await hashTree(repo.root)).toBe(before);
}

describe('opencodev1 hook events and matchers', () => {
  it('binds every carried phase to its V1 event and keeps the matchers', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      await writeFile(
        join(repo.root, '.farna/personas/builder.yaml'),
        [
          'kind: persona',
          'id: builder',
          'displayName: Builder',
          'purpose: Runs the declared hooks.',
          'resources:',
          '  - hook/format-on-save',
          '  - hook/after-tool',
          '  - hook/session-start',
          '  - hook/stop',
          '',
        ].join('\n'),
        'utf8',
      );
      const hooks = [
        {
          id: 'format-on-save',
          phase: 'before-tool',
          matcher: 'Edit|Write',
          command: 'echo FBS_PRE',
        },
        { id: 'after-tool', phase: 'after-tool', matcher: 'Bash', command: 'echo FBS_POST' },
        { id: 'session-start', phase: 'session-start', command: 'echo FBS_START' },
        { id: 'stop', phase: 'stop', command: 'echo FBS_STOP' },
      ];
      for (const hook of hooks) {
        await writeFile(
          join(repo.root, `.farna/resources/hooks/${hook.id}.jsonc`),
          `${JSON.stringify({ kind: 'hook', ...hook }, null, 2)}\n`,
          'utf8',
        );
      }

      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const plugin = await readText(repo.root, '.opencode/plugins/rulesync-hooks.js');
      for (const marker of [
        '"tool.execute.before"',
        '"tool.execute.after"',
        'event.type === "session.created"',
        'event.type === "session.idle"',
        'new RegExp("^(?:edit|write)$")',
        'new RegExp("^(?:bash)$")',
        'echo FBS_PRE',
        'echo FBS_POST',
        'echo FBS_START',
        'echo FBS_STOP',
      ]) {
        expect(plugin).toContain(marker);
      }
      expect((await runCheck(repo.root, new UpstreamRenderTarget())).ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

describe('opencodev1 containment gates fire on the V1 shapes', () => {
  it('refuses a V2 permissions array in a V1 agent file', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      await expectV1Gate(
        repo,
        async (outputRoot) => {
          const text = await readOutput(outputRoot, '.opencode/agents/builder.md');
          expect(text).toContain('permission:');
          await writeOutput(
            outputRoot,
            '.opencode/agents/builder.md',
            text.replace('permission:', 'permissions:'),
          );
        },
        'undeclared key "permissions"',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a V1 agent with no name', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      await expectV1Gate(
        repo,
        async (outputRoot) => {
          const text = await readOutput(outputRoot, '.opencode/agents/builder.md');
          await writeOutput(
            outputRoot,
            '.opencode/agents/builder.md',
            text.replace('name: builder\n', ''),
          );
        },
        'missing "name"',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses the V2 servers envelope in the V1 mcp map', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      await expectV1Gate(
        repo,
        async (outputRoot) => {
          const text = await readOutput(outputRoot, 'opencode.jsonc');
          const config = JSON.parse(text) as { mcp: unknown };
          await writeOutput(
            outputRoot,
            'opencode.jsonc',
            `${JSON.stringify({ mcp: { servers: config.mcp } }, null, 2)}\n`,
          );
        },
        'opencode mcp servers are',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a V1 plugin with a dropped matcher', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      await expectV1Gate(
        repo,
        async (outputRoot) => {
          const text = await readOutput(outputRoot, '.opencode/plugins/rulesync-hooks.js');
          const guard = 'const __re = new RegExp("^(?:edit|write)$");';
          expect(text).toContain(guard);
          await writeOutput(
            outputRoot,
            '.opencode/plugins/rulesync-hooks.js',
            text.replace(guard, ''),
          );
        },
        'registers',
      );
    } finally {
      await repo.cleanup();
    }
  });
});
