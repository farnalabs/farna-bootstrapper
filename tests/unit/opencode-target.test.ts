import { appendFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  it('writes exactly the measured agent-mode path set', async () => {
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
      ]);
      const files = await listFiles(repo.root);
      expect(files).not.toContain('opencode.jsonc');
      expect(files.some((path) => path.startsWith('.opencode/commands/'))).toBe(false);
      expect(files.some((path) => path.startsWith('.opencode/skills/'))).toBe(false);
      expect(files.some((path) => path.startsWith('.opencode/plugins/'))).toBe(false);
      expect(files).not.toContain('AGENTS.md');
      expect(files).not.toContain('CLAUDE.md');
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

  for (const [kind, id] of [
    ['mcp', 'scan'],
    ['skill', 'secure-review'],
    ['command', 'pytest'],
    ['hook', 'format-on-save'],
  ] as const) {
    it(`refuses ${kind}/${id} in agent mode instead of emitting it workspace-wide`, async () => {
      const repo = await createTempRepo('opencode');
      try {
        await appendFile(
          join(repo.root, '.farna/personas/builder.yaml'),
          `  - ${kind}/${id}\n`,
          'utf8',
        );
        const before = await hashTree(repo.root);
        let failure: FarnaError | undefined;
        try {
          await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
        } catch (error) {
          failure = error as FarnaError;
        }
        expect(failure?.code).toBe('F001_INVALID_CONFIG');
        expect(failure?.exitCode).toBe(1);
        expect(failure?.subject).toBe('.farna/personas/builder.yaml');
        expect(failure?.message).toContain(`${kind}/${id}`);
        expect(failure?.message).toContain('builder');
        expect(failure?.message).toContain('requires profile mode');
        expect(await hashTree(repo.root)).toBe(before);
      } finally {
        await repo.cleanup();
      }
    });
  }

  it('warns W112 and W111, and no workspace W101, for a clean agent-mode run', async () => {
    const repo = await createdWithGenerateWarnings();
    try {
      const codes = repo.warnings.map((entry) => entry.code);
      expect(codes).not.toContain('W101_CAPABILITY_DROPPED');
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
      ]);
      expect(lock.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
      expect(
        lock.personas[0]?.resources.map((resource) => `${resource.kind}/${resource.id}`),
      ).toEqual(['rule/house-style', 'permission/builder-default']);
      const codes = lock.warnings.map((entry) => entry.code);
      expect(codes).toContain('W112_PERMISSION_LOSSY');
      expect(codes).not.toContain('W101_CAPABILITY_DROPPED');
      expect(codes).not.toContain('W114_RENDERER_INTEGRITY_UNVERIFIED');
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
      expect(check.warnings.map((entry) => entry.code)).toContain('W112_PERMISSION_LOSSY');
      expect(check.warnings.map((entry) => entry.code)).not.toContain('W101_CAPABILITY_DROPPED');
    } finally {
      await repo.cleanup();
    }
  });

  it('leaves a pre-existing user opencode.jsonc untouched', async () => {
    const repo = await createTempRepo('opencode');
    try {
      const userConfig = '{ "theme": "user-owned" }\n';
      await writeFile(join(repo.root, 'opencode.jsonc'), userConfig, 'utf8');
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      expect(await readText(repo.root, 'opencode.jsonc')).toBe(userConfig);
      const files = await readText(repo.root, '.farna/lock.json');
      expect(files).not.toContain('opencode.jsonc');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a pre-existing agent file with no lockfile, then adopts it on request', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await mkdir(join(repo.root, '.opencode/agents'), { recursive: true });
      const userFile = '---\nname: user-builder\n---\nhand written\n';
      await writeFile(join(repo.root, '.opencode/agents/builder.md'), userFile, 'utf8');
      const before = await hashTree(repo.root);
      let failure: FarnaError | undefined;
      try {
        await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      } catch (error) {
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F007_DRIFT');
      expect(failure?.exitCode).toBe(1);
      expect(failure?.message).toContain('.farna/lock.json is missing');
      expect(failure?.message).toContain('.opencode/agents/builder.md');
      expect(failure?.action).toContain('run generate --adopt');
      expect(await hashTree(repo.root)).toBe(before);

      const adopted = await runGenerate(
        { cwd: repo.root, dryRun: false, adopt: true },
        new UpstreamRenderTarget(),
      );
      expect(adopted.ok).toBe(true);
      expect(adopted.adopted).toContain('.opencode/agents/builder.md');
      expect(await readText(repo.root, '.opencode/agents/builder.md')).not.toBe(userFile);
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('adopts byte-identical outputs only with --adopt when the lockfile was deleted', async () => {
    const repo = await generated();
    try {
      const originalLock = await readText(repo.root, '.farna/lock.json');
      await rm(join(repo.root, '.farna/lock.json'));
      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
      ).rejects.toMatchObject({ code: 'F007_DRIFT', action: expect.stringContaining('--adopt') });

      const result = await runGenerate(
        { cwd: repo.root, dryRun: false, adopt: true },
        new UpstreamRenderTarget(),
      );
      expect(result.files.find((file) => file.path === '.farna/lock.json')?.status).toBe('written');
      expect(await readText(repo.root, '.farna/lock.json')).toBe(originalLock);
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses F007 and writes nothing when the lockfile is gone and an output differs', async () => {
    const repo = await generated();
    try {
      await rm(join(repo.root, '.farna/lock.json'));
      await appendFile(join(repo.root, '.opencode/agents/builder.md'), '\nmanual edit\n', 'utf8');
      const before = await hashTree(repo.root);
      let failure: FarnaError | undefined;
      try {
        await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      } catch (error) {
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F007_DRIFT');
      expect(failure?.exitCode).toBe(1);
      expect(failure?.message).toContain('.farna/lock.json is missing');
      expect(failure?.action).toContain('run generate --adopt');
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('detects drift in an agent file and in the lockfile', async () => {
    const repo = await generated();
    try {
      const agent = await readFile(join(repo.root, '.opencode/agents/builder.md'), 'utf8');
      await appendFile(join(repo.root, '.opencode/agents/builder.md'), '\nmanual\n', 'utf8');
      let check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(false);
      expect(check.drift.map((item) => item.path)).toContain('.opencode/agents/builder.md');
      await writeFile(join(repo.root, '.opencode/agents/builder.md'), agent, 'utf8');

      await appendFile(join(repo.root, '.farna/lock.json'), '\n', 'utf8');
      check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.drift.map((item) => item.path)).toContain('.farna/lock.json');
    } finally {
      await repo.cleanup();
    }
  });

  it('reports a missing managed file and ignores a stray file at any depth', async () => {
    const repo = await generated();
    try {
      const agent = await readFile(join(repo.root, '.opencode/agents/reviewer.md'), 'utf8');
      await rm(join(repo.root, '.opencode/agents/reviewer.md'));
      let check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.drift.map((item) => [item.path, item.kind])).toEqual([
        ['.opencode/agents/reviewer.md', 'missing'],
      ]);
      await writeFile(join(repo.root, '.opencode/agents/reviewer.md'), agent, 'utf8');

      // An unrecorded file inside a managed directory belongs to the user.
      await writeFile(join(repo.root, '.opencode/agents/extra.md'), 'stray\n', 'utf8');
      check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.drift).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('ignores a user-owned opencode.jsonc and a user-owned command', async () => {
    // A repository may keep its own workspace config and its own commands;
    // `check` must not treat unrecorded files as drift, or no OpenCode repo
    // with its own configuration could ever pass.
    const repo = await generated();
    try {
      await writeFile(join(repo.root, 'opencode.jsonc'), '{ "mcp": {} }\n', 'utf8');
      await mkdir(join(repo.root, '.opencode/commands'), { recursive: true });
      await writeFile(
        join(repo.root, '.opencode/commands/custom.md'),
        '# custom command\n',
        'utf8',
      );
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.exitCode).toBe(0);
      expect(check.drift).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('reports a recorded path the source no longer produces', async () => {
    const repo = await generated();
    try {
      const before = await readText(repo.root, '.farna/lock.json');
      const lock = JSON.parse(before) as {
        files: Array<{ path: string; sha256: string; size: number }>;
      };
      lock.files.push({ path: 'opencode.jsonc', sha256: '0'.repeat(64), size: 0 });
      await writeFile(
        join(repo.root, '.farna/lock.json'),
        `${JSON.stringify(lock, null, 2)}\n`,
        'utf8',
      );
      await writeFile(join(repo.root, 'opencode.jsonc'), '{ "mcp": {} }\n', 'utf8');
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(false);
      expect(check.drift).toContainEqual({
        code: 'F007_DRIFT',
        path: 'opencode.jsonc',
        kind: 'unexpected',
        detail: 'path is recorded in the lockfile but no longer produced by this source',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('orders permission patterns by declaration so a later deny wins', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/permissions/ordered.jsonc'),
        JSON.stringify(
          {
            kind: 'permission',
            id: 'ordered',
            tools: { edit: 'allow' },
            patterns: { edit: { 'a/**': 'allow', '**/secret/**': 'deny' } },
          },
          null,
          2,
        ),
        'utf8',
      );
      await appendFile(
        join(repo.root, '.farna/personas/builder.yaml'),
        '  - permission/ordered\n',
        'utf8',
      );
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const frontmatter = frontmatterOf(await readText(repo.root, '.opencode/agents/builder.md'));
      const records = frontmatter['permissions'] as Array<{
        action: string;
        resource: string;
        effect: string;
      }>;
      const editResources = records
        .filter((record) => record.action === 'edit')
        .map((record) => record.resource);
      const allowAt = editResources.indexOf('a/**');
      const denyAt = editResources.indexOf('**/secret/**');
      expect(allowAt).toBeGreaterThanOrEqual(0);
      expect(denyAt).toBeGreaterThan(allowAt);
      expect(records.filter((record) => record.action === 'edit').at(-1)).toEqual({
        action: 'edit',
        resource: '**/secret/**',
        effect: 'deny',
      });
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
      const path = join(repo.root, '.opencode/agents/reviewer.md');
      await rm(path);
      await symlink(victim, path, 'file');
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(false);
      expect(check.drift).toEqual([
        {
          code: 'F007_DRIFT',
          path: '.opencode/agents/reviewer.md',
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
