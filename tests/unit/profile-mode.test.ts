import { appendFile, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FarnaError } from '../../src/core/errors.js';
import type {
  RendererIdentity,
  RenderRequest,
  RenderResult,
  RenderTarget,
} from '../../src/render/port.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';
import {
  createEmptyTempDir,
  createTempRepo,
  hashTree,
  listFiles,
  readText,
  type TempRepo,
} from '../support/temp-repo.js';

const skipSymlinks = process.platform === 'win32';

const BUILDER_PROFILE_FILES = [
  '.farna/lock.json',
  '.opencode/agents/builder.md',
  '.opencode/commands/pytest.md',
  '.opencode/plugins/rulesync-hooks.js',
  '.opencode/skills/secure-review/SKILL.md',
  '.opencode/skills/secure-review/scripts/check.sh',
  'opencode.jsonc',
];

const BUILDER_ORPHANS = [
  '.opencode/agents/builder.md',
  '.opencode/commands/pytest.md',
  '.opencode/plugins/rulesync-hooks.js',
  '.opencode/skills/secure-review/SKILL.md',
  '.opencode/skills/secure-review/scripts/check.sh',
];

async function profileRepo(): Promise<TempRepo> {
  return await createTempRepo('profile');
}

async function generated(persona?: string): Promise<TempRepo> {
  const repo = await profileRepo();
  await runGenerate(
    { cwd: repo.root, dryRun: false, ...(persona === undefined ? {} : { persona }) },
    new UpstreamRenderTarget(),
  );
  return repo;
}

/** Switch the committed selection without touching the CLI override. */
async function setActive(repo: TempRepo, persona: string): Promise<void> {
  const path = join(repo.root, '.farna/config.jsonc');
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace(/"active": "[^"]+"/, `"active": "${persona}"`), 'utf8');
}

async function expectProfileFailure(
  repo: TempRepo,
  run: () => Promise<unknown>,
  code: string,
  subject: string,
  message: string,
): Promise<FarnaError> {
  const before = await hashTree(repo.root);
  let failure: FarnaError | undefined;
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(FarnaError);
    failure = error as FarnaError;
  }
  expect(failure?.code).toBe(code);
  expect(failure?.subject).toBe(subject);
  expect(failure?.message).toContain(message);
  // Every refusal in this suite happens before a byte is written.
  expect(await hashTree(repo.root)).toBe(before);
  return failure as FarnaError;
}

type LockShape = {
  target: string;
  mode: string;
  activePersona: string | null;
  personas: Array<{ id: string }>;
  files: Array<{ path: string }>;
  warnings: Array<{ code: string }>;
};

async function lockOf(repo: TempRepo): Promise<LockShape> {
  return JSON.parse(await readText(repo.root, '.farna/lock.json')) as LockShape;
}

describe('profile mode', () => {
  it('records the computed mode and the active persona in the lockfile', async () => {
    const repo = await generated();
    try {
      const lock = await lockOf(repo);
      expect(lock.target).toBe('opencode');
      expect(lock.mode).toBe('profile');
      expect(lock.activePersona).toBe('builder');
      expect(lock.personas.map((persona) => persona.id)).toEqual(['builder']);
      expect(lock.files.map((file) => file.path)).toEqual(
        BUILDER_PROFILE_FILES.filter((path) => path !== '.farna/lock.json'),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('emits the active persona complete harness at the repository root', async () => {
    const repo = await profileRepo();
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.mode).toBe('profile');
      expect(result.activePersona).toBe('builder');
      expect(result.personas).toEqual(['builder']);
      expect(result.files.map((file) => file.path)).toEqual(BUILDER_PROFILE_FILES);
      // The profile is the repository root, never a cache directory or a
      // subdirectory below another config.
      expect(result.files.every((file) => !file.path.startsWith('../'))).toBe(true);
      expect(result.files.every((file) => !file.path.startsWith('.farna/profiles/'))).toBe(true);
      await expect(lstat(join(repo.root, '.farna/profiles'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const config = JSON.parse(await readText(repo.root, 'opencode.jsonc')) as {
        mcp: { servers: Record<string, Record<string, unknown>> };
      };
      expect(Object.keys(config.mcp.servers)).toEqual(['scan']);
      expect(config.mcp.servers['scan']).toEqual({
        type: 'local',
        command: ['npx', '-y', 'example-security-mcp'],
        environment: { EXAMPLE_TOKEN: '{env:EXAMPLE_TOKEN}' },
      });

      // Skill tree: the declared SKILL.md and the extra file, byte for byte.
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
      expect(plugin).toContain('execute.before');
      expect(plugin).toContain('pnpm exec prettier');
      const agent = await readText(repo.root, '.opencode/agents/builder.md');
      expect(agent).toContain('FBS_RULE_BUILDER_4a1c');
      expect(agent).toContain('permissions:');
    } finally {
      await repo.cleanup();
    }
  });

  it('never emits the inactive persona artefact or any of its resources', async () => {
    const repo = await generated();
    try {
      const files = await listFiles(repo.root);
      expect(files).not.toContain('.opencode/agents/reviewer.md');
      expect(files).not.toContain('.opencode/commands/review-triage.md');
      const config = await readText(repo.root, 'opencode.jsonc');
      expect(config).not.toContain('docs');
      expect(config).not.toContain('DOCS_TOKEN');
      for (const path of BUILDER_PROFILE_FILES) {
        const text = await readText(repo.root, path);
        expect(text, `${path} leaked the reviewer rule`).not.toContain('FBS_RULE_REVIEWER_8d2f');
        expect(text, `${path} leaked the reviewer command`).not.toContain(
          'FBS_COMMAND_REVIEW_7c1d',
        );
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('checks clean after generate, drifts after a manual edit, and ignores a user file', async () => {
    const repo = await generated();
    try {
      const clean = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(clean.ok).toBe(true);
      expect(clean.exitCode).toBe(0);
      expect(clean.mode).toBe('profile');
      expect(clean.activePersona).toBe('builder');
      expect(clean.checked).toEqual(BUILDER_PROFILE_FILES);

      const original = await readText(repo.root, '.opencode/commands/pytest.md');
      await appendFile(join(repo.root, '.opencode/commands/pytest.md'), '\nmanual\n', 'utf8');
      const drifted = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(drifted.ok).toBe(false);
      expect(drifted.drift).toEqual([
        {
          code: 'F007_DRIFT',
          path: '.opencode/commands/pytest.md',
          kind: 'modified',
          detail: 'content differs from a fresh render',
        },
      ]);
      await writeFile(join(repo.root, '.opencode/commands/pytest.md'), original, 'utf8');

      // A user file in a managed directory is not recorded, so it is not drift.
      await writeFile(
        join(repo.root, '.opencode/commands/custom.md'),
        '---\ndescription: Mine\n---\n',
        'utf8',
      );
      await mkdir(join(repo.root, '.opencode/skills/custom'), { recursive: true });
      await writeFile(
        join(repo.root, '.opencode/skills/custom/SKILL.md'),
        '---\nname: custom\ndescription: Mine\n---\n',
        'utf8',
      );
      const withUserFiles = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(withUserFiles.ok).toBe(true);
      expect(withUserFiles.drift).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('lets --persona override the configured active persona', async () => {
    const repo = await profileRepo();
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false, persona: 'reviewer' },
        new UpstreamRenderTarget(),
      );
      expect(result.activePersona).toBe('reviewer');
      expect(result.personas).toEqual(['reviewer']);
      expect(result.files.map((file) => file.path)).toEqual([
        '.farna/lock.json',
        '.opencode/agents/reviewer.md',
        '.opencode/commands/review-triage.md',
        'opencode.jsonc',
      ]);
      expect(await lockOf(repo)).toMatchObject({ mode: 'profile', activePersona: 'reviewer' });
      const config = await readText(repo.root, 'opencode.jsonc');
      expect(config).toContain('docs');
      expect(config).not.toContain('scan');

      const clean = await runCheck(repo.root, new UpstreamRenderTarget(), { persona: 'reviewer' });
      expect(clean.ok).toBe(true);

      // Without the override the config selects builder, so the committed
      // reviewer profile is drift: a stale artefact and missing builder files.
      const withoutOverride = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(withoutOverride.ok).toBe(false);
      const paths = withoutOverride.drift.map((item) => `${item.kind}:${item.path}`);
      expect(paths).toContain('missing:.opencode/agents/builder.md');
      expect(paths).toContain('unexpected:.opencode/agents/reviewer.md');
    } finally {
      await repo.cleanup();
    }
  });

  it('switching the active persona rewrites the profile and removes the old artefacts', async () => {
    const repo = await generated();
    try {
      await setActive(repo, 'reviewer');
      const switched = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(switched.activePersona).toBe('reviewer');
      expect(switched.removed).toEqual(
        BUILDER_ORPHANS.map((path) => ({ path, status: 'removed' })),
      );

      const files = await listFiles(repo.root);
      for (const path of BUILDER_ORPHANS) {
        expect(files).not.toContain(path);
      }
      expect(files).toContain('.opencode/agents/reviewer.md');
      expect(files).toContain('.opencode/commands/review-triage.md');
      expect(files).toContain('opencode.jsonc');
      expect(files.some((path) => path.startsWith('.opencode/plugins/'))).toBe(false);

      const config = await readText(repo.root, 'opencode.jsonc');
      expect(config).toContain('docs');
      expect(config).not.toContain('scan');
      for (const path of await listFiles(repo.root)) {
        if (!path.startsWith('.opencode/') && path !== 'opencode.jsonc') {
          continue;
        }
        const text = await readText(repo.root, path);
        expect(text).not.toContain('FBS_RULE_BUILDER_4a1c');
        expect(text).not.toContain('FBS_SKILL_BODY_2b8e');
        expect(text).not.toContain('FBS_COMMAND_BODY_4d6c');
      }

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.activePersona).toBe('reviewer');
    } finally {
      await repo.cleanup();
    }
  });

  it('removing the last MCP server removes the workspace config', async () => {
    const repo = await generated();
    try {
      const personaPath = join(repo.root, '.farna/personas/builder.yaml');
      const persona = await readFile(personaPath, 'utf8');
      await writeFile(personaPath, persona.replace('  - mcp/scan\n', ''), 'utf8');

      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.removed).toEqual([{ path: 'opencode.jsonc', status: 'removed' }]);
      const files = await listFiles(repo.root);
      expect(files).not.toContain('opencode.jsonc');
      expect(files).toContain('.opencode/agents/builder.md');

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('removing the last MCP server removes a trailing-comma workspace config', async () => {
    const repo = await generated();
    try {
      const document = JSON.parse(
        await readFile(join(repo.root, 'opencode.jsonc'), 'utf8'),
      ) as Record<string, unknown>;
      // The trailing comma is valid JSONC and is exactly the shape the old
      // deletion edit turned into `{ , }`.
      await writeFile(
        join(repo.root, 'opencode.jsonc'),
        `{\n  "mcp": ${JSON.stringify(document['mcp'], null, 2).replaceAll('\n', '\n  ')},\n}\n`,
        'utf8',
      );

      const personaPath = join(repo.root, '.farna/personas/builder.yaml');
      const persona = await readFile(personaPath, 'utf8');
      await writeFile(personaPath, persona.replace('  - mcp/scan\n', ''), 'utf8');

      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.removed).toEqual([{ path: 'opencode.jsonc', status: 'removed' }]);
      const files = await listFiles(repo.root);
      expect(files).not.toContain('opencode.jsonc');
      expect((await runCheck(repo.root, new UpstreamRenderTarget())).ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('removing a skill removes its recorded tree', async () => {
    const repo = await generated();
    try {
      const personaPath = join(repo.root, '.farna/personas/builder.yaml');
      const persona = await readFile(personaPath, 'utf8');
      await writeFile(personaPath, persona.replace('  - skill/secure-review\n', ''), 'utf8');

      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.removed).toEqual([
        { path: '.opencode/skills/secure-review/SKILL.md', status: 'removed' },
        { path: '.opencode/skills/secure-review/scripts/check.sh', status: 'removed' },
      ]);
      const files = await listFiles(repo.root);
      expect(files).not.toContain('.opencode/skills/secure-review/SKILL.md');
      expect(files).not.toContain('.opencode/skills/secure-review/scripts/check.sh');

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('plans orphan removals on a dry run and writes nothing', async () => {
    const repo = await generated();
    try {
      await setActive(repo, 'reviewer');
      const before = await hashTree(repo.root);
      const result = await runGenerate(
        { cwd: repo.root, dryRun: true },
        new UpstreamRenderTarget(),
      );
      expect(result.dryRun).toBe(true);
      expect(result.removed).toEqual(
        BUILDER_ORPHANS.map((path) => ({ path, status: 'would-remove' })),
      );
      expect(await hashTree(repo.root)).toBe(before);
      expect(await listFiles(repo.root)).toContain('.opencode/agents/builder.md');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses to remove a recorded orphan whose bytes changed', async () => {
    const repo = await generated();
    try {
      await appendFile(join(repo.root, '.opencode/agents/builder.md'), '\nhand edit\n', 'utf8');
      await setActive(repo, 'reviewer');
      const failure = await expectProfileFailure(
        repo,
        async () => {
          await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
        },
        'F007_DRIFT',
        '.opencode/agents/builder.md',
        'no longer matches the bytes recorded as owned',
      );
      expect(failure.exitCode).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses to remove a recorded orphan that is no longer a regular file', async () => {
    const repo = await generated();
    try {
      const path = join(repo.root, '.opencode/agents/builder.md');
      await rm(path);
      await mkdir(path);
      await setActive(repo, 'reviewer');
      await expectProfileFailure(
        repo,
        async () => {
          await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
        },
        'F012_WRITE_FAILED',
        '.opencode/agents/builder.md',
        'it is not a regular file',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it.skipIf(skipSymlinks)('never follows a symlink recorded as an orphan', async () => {
    const repo = await generated();
    const outside = await createEmptyTempDir();
    try {
      const path = join(repo.root, '.opencode/agents/builder.md');
      const victim = join(outside.root, 'victim.md');
      await writeFile(victim, 'victim\n', 'utf8');
      await rm(path);
      await symlink(victim, path, 'file');
      await setActive(repo, 'reviewer');
      await expectProfileFailure(
        repo,
        async () => {
          await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
        },
        'F003_PATH_UNSAFE',
        '.opencode/agents/builder.md',
        'symbolic link',
      );
      expect(await readFile(victim, 'utf8')).toBe('victim\n');
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });

  it('reports a recorded orphan as drift and never reports a user file', async () => {
    const repo = await generated();
    try {
      await setActive(repo, 'reviewer');
      await writeFile(
        join(repo.root, '.opencode/commands/custom.md'),
        '---\ndescription: Mine\n---\n',
        'utf8',
      );
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(false);
      expect(check.exitCode).toBe(1);
      const unexpected = check.drift
        .filter((item) => item.kind === 'unexpected')
        .map((item) => item.path);
      expect(unexpected).toEqual(BUILDER_ORPHANS);
      expect(check.drift.map((item) => item.path)).not.toContain('.opencode/commands/custom.md');
      expect(check.drift).toContainEqual({
        code: 'F007_DRIFT',
        path: '.opencode/agents/builder.md',
        kind: 'unexpected',
        detail: 'path is recorded in the lockfile but no longer produced by this source',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects an active persona that names no persona, from config or --persona', async () => {
    const repo = await profileRepo();
    try {
      await setActive(repo, 'ghost');
      await expectProfileFailure(
        repo,
        async () => {
          await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
        },
        'F001_INVALID_CONFIG',
        '.farna/config.jsonc',
        'names no persona',
      );

      // A valid configured persona does not mask a bad override: the flag wins.
      await setActive(repo, 'builder');
      await expectProfileFailure(
        repo,
        async () => {
          await runGenerate(
            { cwd: repo.root, dryRun: false, persona: 'ghost' },
            new UpstreamRenderTarget(),
          );
        },
        'F001_INVALID_CONFIG',
        '--persona',
        'names no persona',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects profile mode on a target that does not support it', async () => {
    const repo = await createTempRepo('demo');
    try {
      await writeFile(
        join(repo.root, '.farna/config.jsonc'),
        '{"schemaVersion":1,"targets":{"claudecode":{"active":"builder"}}}\n',
        'utf8',
      );
      await expectProfileFailure(
        repo,
        async () => {
          await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
        },
        'F001_INVALID_CONFIG',
        '.farna/config.jsonc',
        'does not support profile mode',
      );
      await expectProfileFailure(
        repo,
        async () => {
          await runGenerate(
            { cwd: repo.root, dryRun: false, persona: 'builder' },
            new UpstreamRenderTarget(),
          );
        },
        'F001_INVALID_CONFIG',
        '--persona',
        'does not support profile mode',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('still validates a declaration that only a non-live persona makes', async () => {
    const repo = await profileRepo();
    try {
      await appendFile(
        join(repo.root, '.farna/personas/reviewer.yaml'),
        '  - rule/does-not-exist\n',
        'utf8',
      );
      await expectProfileFailure(
        repo,
        async () => {
          await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
        },
        'F001_INVALID_CONFIG',
        '.farna/personas/reviewer.yaml',
        'unknown rule "does-not-exist"',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('reports an unrepresentable hook as a high-severity W101 in profile mode', async () => {
    const repo = await profileRepo();
    try {
      await appendFile(
        join(repo.root, '.farna/personas/builder.yaml'),
        '  - hook/session-audit\n',
        'utf8',
      );
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      const loss = result.warnings.find((entry) => entry.code === 'W101_CAPABILITY_DROPPED');
      expect(loss).toMatchObject({
        code: 'W101_CAPABILITY_DROPPED',
        severity: 'high',
        persona: 'builder',
        capability: 'hook',
      });
      expect(loss?.message).toContain('session-audit');
      const plugin = await readText(repo.root, '.opencode/plugins/rulesync-hooks.js');
      expect(plugin).not.toContain('FBS_HOOK_SESSION_END_9e1f');
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('keeps a runtime integrity warning out of the lockfile', async () => {
    const repo = await profileRepo();
    try {
      const renderer = new UnverifiedRenderTarget();
      const result = await runGenerate({ cwd: repo.root, dryRun: false }, renderer);
      expect(result.warnings.map((entry) => entry.code)).toContain(
        'W114_RENDERER_INTEGRITY_UNVERIFIED',
      );
      const lock = await lockOf(repo);
      expect(lock.warnings.map((entry) => entry.code)).not.toContain(
        'W114_RENDERER_INTEGRITY_UNVERIFIED',
      );
      // The same source on an unverified machine is still byte-identical to a
      // verified one, so `check` does not report false drift.
      const check = await runCheck(repo.root, renderer);
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('produces identical bytes in two independent roots', async () => {
    const first = await profileRepo();
    const second = await profileRepo();
    try {
      await runGenerate({ cwd: first.root, dryRun: false }, new UpstreamRenderTarget());
      await runGenerate({ cwd: second.root, dryRun: false }, new UpstreamRenderTarget());
      expect(await readText(first.root, '.farna/lock.json')).toBe(
        await readText(second.root, '.farna/lock.json'),
      );
      expect(await hashTree(first.root)).toBe(await hashTree(second.root));
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it('accepts active in the config schema and still rejects exclude', async () => {
    const { configSchema } = await import('../../src/config/schema.js');
    expect(
      configSchema.safeParse({ schemaVersion: 1, targets: { opencode: { active: 'builder' } } })
        .success,
    ).toBe(true);
    expect(
      configSchema.safeParse({ schemaVersion: 1, targets: { opencode: { exclude: ['builder'] } } })
        .success,
    ).toBe(false);
    expect(
      configSchema.safeParse({ schemaVersion: 1, targets: { opencode: { active: 'Not Kebab' } } })
        .success,
    ).toBe(false);
  });

  it('limits orphan removal to managed locations across both targets', async () => {
    const { isManagedOutputPath } = await import('../../src/render/orphans.js');
    expect(isManagedOutputPath('opencode.jsonc')).toBe(true);
    expect(isManagedOutputPath('.opencode/agents/builder.md')).toBe(true);
    expect(isManagedOutputPath('.opencode/commands/pytest.md')).toBe(true);
    expect(isManagedOutputPath('.opencode/skills/secure-review/SKILL.md')).toBe(true);
    expect(isManagedOutputPath('.opencode/plugins/rulesync-hooks.js')).toBe(true);
    expect(isManagedOutputPath('.claude/agents/builder.md')).toBe(true);
    expect(isManagedOutputPath('.opencode')).toBe(false);
    expect(isManagedOutputPath('.opencode/')).toBe(false);
    expect(isManagedOutputPath('AGENTS.md')).toBe(false);
    expect(isManagedOutputPath('src/index.ts')).toBe(false);
  });

  it('mentions profile mode and --persona in init next-step and --help', async () => {
    const { runInit } = await import('../../src/cli/commands/init.js');
    const { buildProgram } = await import('../../src/cli/program.js');
    const repo = await createEmptyTempDir();
    try {
      const init = await runInit(repo.root);
      expect(init.nextStep).toContain('profile mode');
      expect(init.nextStep).toContain('--persona');

      const program = buildProgram({
        cwd: repo.root,
        renderer: new UpstreamRenderTarget(),
        stdout: () => undefined,
        argv: ['node', 'farna-bootstrapper'],
      });
      const help: string[] = [];
      program.configureOutput({
        writeOut: (text) => help.push(text),
        writeErr: () => undefined,
      });
      program.outputHelp();
      expect(help.join('')).toContain('Profile mode');
      const generate = program.commands.find((command) => command.name() === 'generate');
      expect(generate?.helpInformation()).toContain('--persona');
    } finally {
      await repo.cleanup();
    }
  });
});

/**
 * The real renderer with an identity that could not be verified. The version
 * still matches the pin, so the run proceeds and reports `W114`; the lockfile
 * must record source-derived state only.
 */
class UnverifiedRenderTarget implements RenderTarget {
  private readonly inner = new UpstreamRenderTarget();

  identity(): RendererIdentity {
    return {
      name: 'rulesync',
      version: '43.11.0',
      integrityRecord: { verified: false, reason: 'no-record' },
    };
  }

  recordedIdentity(): RendererIdentity {
    return this.inner.recordedIdentity();
  }

  async generate(request: RenderRequest): Promise<RenderResult> {
    return await this.inner.generate(request);
  }
}
