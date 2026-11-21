import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { runInit } from '../../src/cli/commands/init.js';
import { OUTSIDE_OWNERSHIP_CODE } from '../../src/core/constants.js';
import { FarnaError } from '../../src/core/errors.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';
import { formatCheck, formatGenerate } from '../../src/report/format.js';
import {
  createEmptyTempDir,
  createTempRepo,
  hashTree,
  listFiles,
  readText,
  type TempRepo,
} from '../support/temp-repo.js';

async function generated(persona?: string): Promise<TempRepo> {
  const repo = await createTempRepo('profile');
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

async function jsonOf(repo: TempRepo, path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readText(repo.root, path)) as Record<string, unknown>;
}

describe('structured ownership of opencode.jsonc', () => {
  it('preserves a user key across generate and check, and is not drift', async () => {
    const repo = await generated();
    try {
      const document = await jsonOf(repo, 'opencode.jsonc');
      document['theme'] = 'dark';
      document['instructions'] = ['AGENTS.md'];
      document['$schema'] = 'https://example.test/opencode.schema.json';
      await writeFile(
        join(repo.root, 'opencode.jsonc'),
        `${JSON.stringify(document, null, 2)}\n`,
        'utf8',
      );

      const foreignEdit = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(foreignEdit.drift).toEqual([]);
      expect(foreignEdit.ok).toBe(true);

      // We preserve the user's values, not their whitespace: the first merge
      // canonicalises the document (sorted keys), so it is a write. The next
      // run is byte-stable.
      const again = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(again.files.find((file) => file.path === 'opencode.jsonc')?.status).toBe('written');
      const merged = await jsonOf(repo, 'opencode.jsonc');
      expect(merged['theme']).toBe('dark');
      expect(merged['instructions']).toEqual(['AGENTS.md']);
      expect(merged['$schema']).toBe('https://example.test/opencode.schema.json');
      expect(merged['mcp']).toEqual(document['mcp']);

      const clean = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(clean.ok).toBe(true);

      const third = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(third.files.find((file) => file.path === 'opencode.jsonc')?.status).toBe('unchanged');
    } finally {
      await repo.cleanup();
    }
  });

  it('reports a change to the owned mcp key as drift, naming the key', async () => {
    const repo = await generated();
    try {
      const document = await jsonOf(repo, 'opencode.jsonc');
      const mcp = document['mcp'] as { servers: Record<string, { command?: string[] }> };
      const server = mcp.servers['scan'];
      if (server !== undefined) {
        server.command = ['npx', '-y', 'some-other-server'];
      }
      await writeFile(
        join(repo.root, 'opencode.jsonc'),
        `${JSON.stringify(document, null, 2)}\n`,
        'utf8',
      );

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(false);
      expect(check.drift).toContainEqual({
        code: 'F007_DRIFT',
        path: 'opencode.jsonc',
        kind: 'modified',
        detail: 'owned key(s) mcp differ from a fresh render',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('never takes over an unrecorded user file that carries no owned key', async () => {
    const repo = await createTempRepo('profile');
    try {
      const userConfig = `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`;
      await writeFile(join(repo.root, 'opencode.jsonc'), userConfig, 'utf8');
      const before = await hashTree(repo.root);

      let failure: FarnaError | undefined;
      try {
        await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      } catch (error) {
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F007_DRIFT');
      expect(failure?.subject).toBe('opencode.jsonc');
      expect(failure?.message).toContain('not recorded in the committed lockfile');
      expect(await readText(repo.root, 'opencode.jsonc')).toBe(userConfig);
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('records the owned subset, so two roots with different user keys record identical lockfiles', async () => {
    const first = await generated();
    const second = await generated();
    try {
      const document = await jsonOf(second, 'opencode.jsonc');
      document['theme'] = 'light';
      await writeFile(
        join(second.root, 'opencode.jsonc'),
        `${JSON.stringify(document, null, 2)}\n`,
        'utf8',
      );
      await runGenerate({ cwd: second.root, dryRun: false }, new UpstreamRenderTarget());

      const lock = await jsonOf(first, '.farna/lock.json');
      const entry = (lock['files'] as Array<Record<string, unknown>>).find(
        (file) => file['path'] === 'opencode.jsonc',
      );
      expect(entry).toMatchObject({ shape: 'structured', ownedKeys: ['mcp'] });
      expect(await readText(first.root, '.farna/lock.json')).toBe(
        await readText(second.root, '.farna/lock.json'),
      );
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });
});

describe('profile root cleanliness', () => {
  it('reports the previous persona artefacts after the lockfile is lost', async () => {
    const repo = await generated();
    try {
      await rm(join(repo.root, '.farna/lock.json'));
      await setActive(repo, 'reviewer');

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(false);
      const outside = check.drift
        .filter((item) => item.code === OUTSIDE_OWNERSHIP_CODE)
        .map((item) => item.path);
      expect(outside).toEqual([
        '.opencode/agents/builder.md',
        '.opencode/commands/pytest.md',
        '.opencode/plugins/rulesync-hooks.js',
        '.opencode/skills/secure-review/SKILL.md',
        '.opencode/skills/secure-review/scripts/check.sh',
      ]);
      for (const item of check.drift.filter((entry) => entry.code === OUTSIDE_OWNERSHIP_CODE)) {
        expect(item.detail).toBe(
          'a plausible prior render is present but the lockfile does not record it',
        );
      }

      // `generate` reports the same tree instead of overwriting or ignoring it.
      const before = await hashTree(repo.root);
      let failure: FarnaError | undefined;
      try {
        await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      } catch (error) {
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F007_DRIFT');
      expect(failure?.message).toContain('look like an earlier render');
      expect(failure?.message).toContain('.opencode/agents/builder.md');
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('does not report a file whose name no declaration would emit', async () => {
    const repo = await generated();
    try {
      await rm(join(repo.root, '.farna/lock.json'));
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

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      const outside = check.drift.filter((item) => item.code === OUTSIDE_OWNERSHIP_CODE);
      expect(outside).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('reports an extra file inside a skill tree and never deletes it (skill-extra-file)', async () => {
    const repo = await generated();
    try {
      const extra = join(repo.root, '.opencode/skills/secure-review/scripts/extra.sh');
      await writeFile(extra, 'echo extra\n', 'utf8');

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(false);
      expect(check.drift).toContainEqual({
        code: OUTSIDE_OWNERSHIP_CODE,
        path: '.opencode/skills/secure-review/scripts/extra.sh',
        kind: 'unexpected',
        detail: 'an unrecorded file is inside a managed skill directory',
      });

      const regenerated = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(regenerated.ok).toBe(true);
      expect(await listFiles(repo.root)).toContain(
        '.opencode/skills/secure-review/scripts/extra.sh',
      );
    } finally {
      await repo.cleanup();
    }
  });
});

describe('profile mode reports the personas it deactivates', () => {
  it('records and prints notLive, and warns W109 only when profile is a choice', async () => {
    const repo = await generated();
    try {
      const lock = await jsonOf(repo, '.farna/lock.json');
      expect(lock['notLive']).toEqual(['reviewer']);

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.notLive).toEqual(['reviewer']);
      const report = formatCheck(check);
      expect(report).toContain('not live reviewer');

      // The fixture declares an MCP server and a hook, which OpenCode carries
      // only at the workspace level, so profile mode is forced: no W109.
      expect(check.warnings.map((entry) => entry.code)).not.toContain('W109_PROFILE_BY_CHOICE');
    } finally {
      await repo.cleanup();
    }
  });

  it('warns W109_PROFILE_BY_CHOICE at info when no persona forces the profile', async () => {
    const repo = await createTempRepo('profile');
    try {
      await writeFile(
        join(repo.root, '.farna/personas/builder.yaml'),
        [
          'kind: persona',
          'id: builder',
          'displayName: Builder',
          'purpose: Writes code and runs the tests.',
          'resources:',
          '  - rule/house-style',
          '  - permission/builder-default',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(repo.root, '.farna/personas/reviewer.yaml'),
        [
          'kind: persona',
          'id: reviewer',
          'displayName: Reviewer',
          'purpose: Reviews a change and reports what it could not verify.',
          'resources:',
          '  - rule/review-checklist',
          '  - permission/review-only',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.mode).toBe('profile');
      expect(result.notLive).toEqual(['reviewer']);
      const choice = result.warnings.find((entry) => entry.code === 'W109_PROFILE_BY_CHOICE');
      expect(choice).toMatchObject({
        code: 'W109_PROFILE_BY_CHOICE',
        severity: 'info',
        persona: 'builder',
      });

      const lock = await jsonOf(repo, '.farna/lock.json');
      expect(lock['warnings']).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'W109_PROFILE_BY_CHOICE' })]),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('validates the committed active persona even when --persona overrides it', async () => {
    const repo = await createTempRepo('profile');
    try {
      await setActive(repo, 'ghost');
      await expect(
        runGenerate(
          { cwd: repo.root, dryRun: false, persona: 'builder' },
          new UpstreamRenderTarget(),
        ),
      ).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: '.farna/config.jsonc',
        message: expect.stringContaining('names no persona'),
      });
    } finally {
      await repo.cleanup();
    }
  });
});

describe('source digest', () => {
  it('fails check when a non-live persona declaration changes', async () => {
    const repo = await generated();
    try {
      // reviewer is resolved but not live, so this edit renders no managed byte.
      await appendFile(
        join(repo.root, '.farna/resources/rules/review-checklist.md'),
        '\nRead the issue before the code.\n',
        'utf8',
      );

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(false);
      expect(check.drift).toContainEqual({
        code: 'F007_DRIFT',
        path: '.farna/lock.json',
        kind: 'modified',
        detail: 'the source or config changed since the lockfile was written; re-run generate',
      });

      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      const clean = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(clean.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

describe('init to profile to check', () => {
  it('follows the init next-step into a clean OpenCode profile', async () => {
    const repo = await createEmptyTempDir();
    try {
      const init = await runInit(repo.root);
      // The next step must be followable: it names the replacement targets
      // block, because `init` writes the claudecode target only.
      expect(init.nextStep).toContain('replace the "targets" block');
      expect(init.nextStep).toContain('"opencode": { "active": "<persona-id>" }');

      await writeFile(
        join(repo.root, '.farna/config.jsonc'),
        `${JSON.stringify(
          { schemaVersion: 1, targets: { opencode: { active: 'builder' } } },
          null,
          2,
        )}\n`,
        'utf8',
      );
      await writeFile(
        join(repo.root, '.farna/personas/builder.yaml'),
        [
          'kind: persona',
          'id: builder',
          'displayName: Builder',
          'purpose: Writes code.',
          'resources:',
          '  - rule/house-style',
          '  - mcp/scan',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(repo.root, '.farna/resources/rules/house-style.md'),
        '---\nkind: rule\nid: house-style\ndisplayName: House style\n---\n\nRead the diff first.\n',
        'utf8',
      );
      await writeFile(
        join(repo.root, '.farna/resources/mcp/scan.jsonc'),
        `${JSON.stringify(
          {
            kind: 'mcp',
            id: 'scan',
            server: { type: 'stdio', command: 'npx', args: ['-y', 'scan'] },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );

      const generated = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(generated.mode).toBe('profile');
      expect(generated.activePersona).toBe('builder');
      expect(generated.files.map((file) => file.path)).toEqual([
        '.farna/lock.json',
        '.opencode/agents/builder.md',
        'opencode.jsonc',
      ]);

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.exitCode).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });
});

describe('MCP arguments', () => {
  it('warns W116 on a credential-shaped literal argument and never echoes it', async () => {
    const repo = await createTempRepo('profile');
    try {
      const path = join(repo.root, '.farna/resources/mcp/scan.jsonc');
      const document = JSON.parse(await readFile(path, 'utf8')) as {
        server: { args: string[] };
      };
      const secret = 'sk-live-ABCDEF0123456789abcdef';
      document.server.args = ['-y', secret, 'example-security-mcp'];
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      const finding = result.warnings.find((entry) => entry.code === 'W116_SECRET_IN_ARGS');
      expect(finding).toMatchObject({
        code: 'W116_SECRET_IN_ARGS',
        severity: 'high',
        capability: 'mcp',
        persona: '<source>',
      });
      expect(finding?.message).toContain('argument 2');
      expect(finding?.message).not.toContain(secret);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a fromEnv reference in args, which the renderer cannot express', async () => {
    const repo = await createTempRepo('profile');
    try {
      const path = join(repo.root, '.farna/resources/mcp/scan.jsonc');
      const document = JSON.parse(await readFile(path, 'utf8')) as {
        server: { args: unknown[] };
      };
      document.server.args = ['-y', { fromEnv: 'EXAMPLE_TOKEN' }];
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
      ).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: '.farna/resources/mcp/scan.jsonc',
        message: expect.stringContaining('cannot be expressed'),
      });
    } finally {
      await repo.cleanup();
    }
  });
});

describe('rendering edge cases', () => {
  it('accepts a hook command containing a backtick', async () => {
    const repo = await createTempRepo('profile');
    try {
      const path = join(repo.root, '.farna/resources/hooks/format-on-save.jsonc');
      const document = JSON.parse(await readFile(path, 'utf8')) as { command: string };
      document.command = 'pnpm exec prettier --write "`git rev-parse --show-toplevel`/$FILE"';
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.ok).toBe(true);
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

describe('reporting', () => {
  it('aligns every status column and includes removals in the summary', () => {
    const report = formatGenerate({
      ok: true,
      target: 'opencode',
      mode: 'profile',
      activePersona: 'reviewer',
      notLive: ['builder'],
      dryRun: false,
      personas: ['reviewer'],
      files: [{ path: '.opencode/agents/reviewer.md', status: 'written' }],
      removed: [
        { path: '.opencode/agents/builder.md', status: 'removed' },
        { path: '.opencode/plugins/rulesync-hooks.js', status: 'missing' },
      ],
      warnings: [],
    });
    expect(report).toContain('managed 1 file(s), 0 unchanged, 1 removed');
    expect(report).toContain('not live builder');
    const lines = report.split('\n');
    const fileLine = lines.find((line) => line.includes('.opencode/agents/reviewer.md'));
    const removalLine = lines.find((line) => line.includes('.opencode/agents/builder.md'));
    expect(fileLine?.indexOf('.opencode/agents/reviewer.md')).toBe(
      removalLine?.indexOf('.opencode/agents/builder.md'),
    );
  });

  it('escapes a control character in a printed subject', () => {
    const failure = new FarnaError('F001_INVALID_CONFIG', 'subject is unsafe', {
      subject: 'a\u001b[31mb',
    });
    expect(failure.format()).toContain('a\\u001b[31mb');
    expect(failure.format()).not.toContain('\u001b');
  });
});
