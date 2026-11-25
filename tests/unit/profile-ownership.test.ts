import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allCheckDrift, runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { runInit } from '../../src/cli/commands/init.js';
import { OUTSIDE_OWNERSHIP_CODE } from '../../src/core/constants.js';
import { FarnaError } from '../../src/core/errors.js';
import { parseJsonc } from '../../src/core/json.js';
import { stagingName } from '../../src/render/staging.js';
import { mergeStructuredText } from '../../src/render/structured.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';
import { formatCheck, formatGenerate } from '../../src/report/format.js';
import {
  createEmptyTempDir,
  createTempRepo,
  hashTree,
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
  return parseJsonc<Record<string, unknown>>(await readText(repo.root, path), { subject: path });
}

/** Every generated path across every target and the run-level lockfile. */
function allGeneratedFiles(result: {
  targets: Array<{ files: Array<{ path: string }> }>;
  files: Array<{ path: string }>;
}): string[] {
  return [...result.targets.flatMap((target) => target.files), ...result.files]
    .map((file) => file.path)
    .sort();
}

describe('structured ownership of opencode.jsonc', () => {
  it("preserves the user's comments, whitespace and foreign keys across generate", async () => {
    const repo = await generated();
    try {
      const merged = await readText(repo.root, 'opencode.jsonc');
      const withComments = [
        "// the user's own header comment",
        '{',
        '  // their theme, their comment',
        '  "theme": "dark",',
        '  "instructions": ["AGENTS.md"],',
        '  "$schema": "https://example.test/opencode.schema.json",',
        `  "mcp": ${JSON.stringify(JSON.parse(merged)['mcp'], null, 2).replaceAll('\n', '\n  ')}`,
        '}',
        '',
      ].join('\n');
      await writeFile(join(repo.root, 'opencode.jsonc'), withComments, 'utf8');

      const foreignEdit = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(allCheckDrift(foreignEdit)).toEqual([]);
      expect(foreignEdit.ok).toBe(true);

      const again = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(
        [...(again.targets[0]?.files ?? []), ...again.files].find(
          (file) => file.path === 'opencode.jsonc',
        )?.status,
      ).toBe('unchanged');
      const after = await readText(repo.root, 'opencode.jsonc');
      expect(after).toBe(withComments);
      expect(after).toContain("// the user's own header comment");
      expect(after).toContain('// their theme, their comment');
      expect((await jsonOf(repo, 'opencode.jsonc'))['theme']).toBe('dark');

      const clean = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(clean.ok).toBe(true);
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
      expect(allCheckDrift(check)).toContainEqual({
        code: 'F007_DRIFT',
        path: 'opencode.jsonc',
        kind: 'modified',
        detail: 'owned key(s) mcp differ from a fresh render',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('deletes the owned key in place when the generated document has no mcp', () => {
    const existing = '// keep me\n{\n  "theme": "dark",\n  "mcp": { "servers": {} }\n}\n';
    const merged = mergeStructuredText(existing, '{}\n', ['mcp'], 'opencode.jsonc');
    expect(parseJsonc<Record<string, unknown>>(merged, { subject: 'merged' })).toEqual({
      theme: 'dark',
    });
    expect(merged).toContain('// keep me');
    expect(merged).not.toContain('"mcp"');
  });

  it('deletes the owned key from a trailing-comma document with a foreign key', () => {
    const existing = '{\n  "theme": "dark",\n  "mcp": { "servers": {} },\n}\n';
    const merged = mergeStructuredText(existing, '{}\n', ['mcp'], 'opencode.jsonc');
    expect(parseJsonc<Record<string, unknown>>(merged, { subject: 'merged' })).toEqual({
      theme: 'dark',
    });
    expect(merged).toContain('"theme": "dark"');
  });

  it('deletes the only owned key from a trailing-comma document without leaving invalid JSONC', () => {
    const existing = '{\n  "mcp": { "servers": {} },\n}\n';
    const merged = mergeStructuredText(existing, '{}\n', ['mcp'], 'opencode.jsonc');
    expect(parseJsonc<Record<string, unknown>>(merged, { subject: 'merged' })).toEqual({});
  });

  it('does not take over an unrecorded user file with no owned key without --adopt', async () => {
    const repo = await generated();
    try {
      // The lockfile exists and records the other managed outputs, but not
      // this path: the file is the user's until they opt in with --adopt.
      const lock = await jsonOf(repo, '.farna/lock.json');
      const targets = lock['targets'] as Record<string, { files: Array<Record<string, unknown>> }>;
      const entry = targets['opencode'];
      if (entry === undefined) {
        throw new Error('expected an opencode target entry');
      }
      entry.files = entry.files.filter((file) => file['path'] !== 'opencode.jsonc');
      await writeFile(
        join(repo.root, '.farna/lock.json'),
        `${JSON.stringify(lock, null, 2)}\n`,
        'utf8',
      );
      const userConfig = '// user file\n{\n  "theme": "dark",\n}\n';
      await writeFile(join(repo.root, 'opencode.jsonc'), userConfig, 'utf8');

      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
      ).rejects.toMatchObject({
        code: 'F007_DRIFT',
        action: expect.stringContaining('run generate --adopt'),
      });
      expect(await readText(repo.root, 'opencode.jsonc')).toBe(userConfig);

      const adopted = await runGenerate(
        { cwd: repo.root, dryRun: false, adopt: true },
        new UpstreamRenderTarget(),
      );
      expect(adopted.ok).toBe(true);
      const after = await readText(repo.root, 'opencode.jsonc');
      expect(after).toContain('// user file');
      const document = parseJsonc<Record<string, unknown>>(after, { subject: 'opencode.jsonc' });
      expect(document['theme']).toBe('dark');
      expect((document['mcp'] as { servers: Record<string, unknown> }).servers).toHaveProperty(
        'scan',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('adopts a user opencode.jsonc only with --adopt, merging the owned key', async () => {
    const repo = await createTempRepo('profile');
    try {
      const userConfig = [
        '// user header',
        '{',
        '  "theme": "dark",',
        '  "mcp": { "servers": { "user": { "type": "local" } } }',
        '}',
        '',
      ].join('\n');
      await writeFile(join(repo.root, 'opencode.jsonc'), userConfig, 'utf8');

      // Without a lockfile the tool refuses and names the outputs, not the bytes.
      let failure: FarnaError | undefined;
      try {
        await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      } catch (error) {
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F007_DRIFT');
      expect(failure?.message).toContain('is missing');
      expect(failure?.message).toContain('opencode.jsonc');
      expect(failure?.action).toContain('run generate --adopt');
      expect(await readText(repo.root, 'opencode.jsonc')).toBe(userConfig);

      const adopted = await runGenerate(
        { cwd: repo.root, dryRun: false, adopt: true },
        new UpstreamRenderTarget(),
      );
      expect(adopted.ok).toBe(true);
      expect(adopted.adopted).toContain('opencode.jsonc');
      const after = await readText(repo.root, 'opencode.jsonc');
      expect(after).toContain('// user header');
      const document = parseJsonc<Record<string, unknown>>(after, { subject: 'opencode.jsonc' });
      expect(document['theme']).toBe('dark');
      // The owned key is replaced by the fresh render; the user's server is gone
      // because it was inside the key this tool owns.
      expect((document['mcp'] as { servers: Record<string, unknown> }).servers).toHaveProperty(
        'scan',
      );
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a differing owned key without --adopt, and keeps the file', async () => {
    const repo = await generated();
    try {
      await rm(join(repo.root, '.farna/lock.json'));
      const text = await readText(repo.root, 'opencode.jsonc');
      const document = JSON.parse(text) as Record<string, unknown>;
      (
        document['mcp'] as { servers: Record<string, { command?: string[]; type?: string }> }
      ).servers['scan'] = {
        command: ['npx', '-y', 'a-different-server'],
        type: 'local',
      };
      const edited = `${JSON.stringify(document, null, 2)}\n`;
      await writeFile(join(repo.root, 'opencode.jsonc'), edited, 'utf8');
      const before = await hashTree(repo.root);

      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
      ).rejects.toMatchObject({
        code: 'F007_DRIFT',
        action: expect.stringContaining('run generate --adopt'),
      });
      expect(await readText(repo.root, 'opencode.jsonc')).toBe(edited);
      expect(await hashTree(repo.root)).toBe(before);

      const adopted = await runGenerate(
        { cwd: repo.root, dryRun: false, adopt: true },
        new UpstreamRenderTarget(),
      );
      expect(adopted.ok).toBe(true);
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
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
      const targets = lock['targets'] as Record<string, { files: Array<Record<string, unknown>> }>;
      const entry = targets['opencode']?.files.find((file) => file['path'] === 'opencode.jsonc');
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

describe('a missing lockfile', () => {
  it('refuses check with the drift code, naming the outputs and the adopt action', async () => {
    const repo = await generated();
    try {
      await rm(join(repo.root, '.farna/lock.json'));
      const before = await hashTree(repo.root);
      let failure: FarnaError | undefined;
      try {
        await runCheck(repo.root, new UpstreamRenderTarget());
      } catch (error) {
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F007_DRIFT');
      expect(failure?.exitCode).toBe(1);
      expect(failure?.message).toContain('.farna/lock.json is missing');
      expect(failure?.message).toContain('.opencode/agents/builder.md');
      expect(failure?.action).toContain('run generate --adopt');
      expect(failure?.action).toContain('check never adopts');
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses generate and writes nothing until --adopt is passed', async () => {
    const repo = await generated();
    try {
      await rm(join(repo.root, '.farna/lock.json'));
      const before = await hashTree(repo.root);
      let failure: FarnaError | undefined;
      try {
        await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      } catch (error) {
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F007_DRIFT');
      expect(failure?.message).toContain('opencode.jsonc');
      expect(failure?.action).toContain('run generate --adopt');
      expect(await hashTree(repo.root)).toBe(before);

      const adopted = await runGenerate(
        { cwd: repo.root, dryRun: false, adopt: true },
        new UpstreamRenderTarget(),
      );
      expect(adopted.ok).toBe(true);
      expect(adopted.adopted).toContain('.opencode/agents/builder.md');
      expect(adopted.adopted).toContain('opencode.jsonc');
      const clean = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(clean.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('ignores a staging sibling inside a skill directory', async () => {
    const repo = await generated();
    try {
      const staging = `.opencode/skills/secure-review/scripts/${stagingName('check.sh')}`;
      await writeFile(join(repo.root, staging), 'partial write\n', 'utf8');
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(allCheckDrift(check).filter((item) => item.code === OUTSIDE_OWNERSHIP_CODE)).toEqual(
        [],
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('neither adopts nor removes a file that is not in the plan', async () => {
    const repo = await generated();
    try {
      await rm(join(repo.root, '.farna/lock.json'));
      const custom = join(repo.root, '.opencode/commands/custom.md');
      const customText = '---\ndescription: Mine\n---\n\nMy own command.\n';
      await writeFile(custom, customText, 'utf8');

      const adopted = await runGenerate(
        { cwd: repo.root, dryRun: false, adopt: true },
        new UpstreamRenderTarget(),
      );
      expect(adopted.ok).toBe(true);
      expect(await readText(repo.root, '.opencode/commands/custom.md')).toBe(customText);
      const lock = await jsonOf(repo, '.farna/lock.json');
      const targets = lock['targets'] as Record<string, { files: Array<{ path: string }> }>;
      expect((targets['opencode']?.files ?? []).map((file) => file.path)).not.toContain(
        '.opencode/commands/custom.md',
      );

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
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
      const targets = lock['targets'] as Record<string, { notLive: string[] }>;
      expect(targets['opencode']?.notLive).toEqual(['reviewer']);

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.targets[0]?.notLive).toEqual(['reviewer']);
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
      expect(result.targets[0]?.mode).toBe('profile');
      expect(result.targets[0]?.notLive).toEqual(['reviewer']);
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

  it('computes W109 from the live persona, so an inactive mcp or hook does not force the profile', async () => {
    const repo = await createTempRepo('profile');
    try {
      await writeFile(
        join(repo.root, '.farna/personas/builder.yaml'),
        [
          'kind: persona',
          'id: builder',
          'displayName: Builder',
          'purpose: Writes code.',
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
          'purpose: Reviews a change.',
          'resources:',
          '  - rule/review-checklist',
          '  - mcp/docs',
          '  - hook/format-on-save',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.targets[0]?.activePersona).toBe('builder');
      expect(result.targets[0]?.notLive).toEqual(['reviewer']);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'W109_PROFILE_BY_CHOICE', persona: 'builder' }),
        ]),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("reports a non-live persona's source-derived warning, scoped by persona", async () => {
    const repo = await createTempRepo('profile');
    try {
      await writeFile(
        join(repo.root, '.farna/personas/reviewer.yaml'),
        [
          'kind: persona',
          'id: reviewer',
          'displayName: Reviewer',
          'purpose: Reviews a change.',
          'resources:',
          '  - rule/review-checklist',
          '  - hook/session-audit',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.targets[0]?.personas).toEqual(['builder']);
      const loss = result.warnings.find((entry) => entry.code === 'W101_CAPABILITY_DROPPED');
      expect(loss).toMatchObject({
        code: 'W101_CAPABILITY_DROPPED',
        severity: 'high',
        persona: 'reviewer',
        capability: 'hook',
      });
      const lock = await jsonOf(repo, '.farna/lock.json');
      expect(lock['warnings']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'W101_CAPABILITY_DROPPED', persona: 'reviewer' }),
        ]),
      );
      // The inactive persona's loss does not make the tree dirty.
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
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
      expect(allCheckDrift(check)).toContainEqual({
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

it('fails check when only a config comment changes', async () => {
  const repo = await generated();
  try {
    await appendFile(join(repo.root, '.farna/config.jsonc'), '\n// a new comment\n', 'utf8');
    const check = await runCheck(repo.root, new UpstreamRenderTarget());
    expect(check.ok).toBe(false);
    expect(allCheckDrift(check)).toContainEqual({
      code: 'F007_DRIFT',
      path: '.farna/lock.json',
      kind: 'modified',
      detail: 'the source or config changed since the lockfile was written; re-run generate',
    });

    await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
    expect((await runCheck(repo.root, new UpstreamRenderTarget())).ok).toBe(true);
  } finally {
    await repo.cleanup();
  }
});

it('fails check when a parsed config value changes', async () => {
  const repo = await generated();
  try {
    const path = join(repo.root, '.farna/config.jsonc');
    const text = await readFile(path, 'utf8');
    await writeFile(
      path,
      text.replace('anthropic/claude-sonnet-4-5', 'anthropic/claude-opus-4-5'),
      'utf8',
    );
    const check = await runCheck(repo.root, new UpstreamRenderTarget());
    expect(check.ok).toBe(false);
    expect(allCheckDrift(check).map((item) => item.path)).toContain('.farna/lock.json');
  } finally {
    await repo.cleanup();
  }
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
      expect(generated.targets[0]?.mode).toBe('profile');
      expect(generated.targets[0]?.activePersona).toBe('builder');
      expect(allGeneratedFiles(generated)).toEqual([
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
      dryRun: false,
      adopted: [],
      targets: [
        {
          target: 'opencode',
          mode: 'profile',
          activePersona: 'reviewer',
          notLive: ['builder'],
          personas: ['reviewer'],
          files: [{ path: '.opencode/agents/reviewer.md', status: 'written' }],
          removed: [
            { path: '.opencode/agents/builder.md', status: 'removed' },
            { path: '.opencode/plugins/rulesync-hooks.js', status: 'missing' },
          ],
        },
      ],
      files: [],
      removed: [],
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

  it('says where each workspace kind is written, in init and in --help', async () => {
    const { runInit } = await import('../../src/cli/commands/init.js');
    const { buildProgram } = await import('../../src/cli/program.js');
    const repo = await createEmptyTempDir();
    try {
      const init = await runInit(repo.root);
      expect(init.nextStep).toContain('under .opencode/');
      expect(init.nextStep).not.toContain('emitted at the repository root');

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
      expect(help.join('')).toContain('under .opencode/');
      expect(help.join('')).not.toContain('emitted there');
    } finally {
      await repo.cleanup();
    }
  });

  it('escapes a control character in the message and the action', () => {
    const failure = new FarnaError('F001_INVALID_CONFIG', 'message\u001b[31mred', {
      subject: 'subject',
      action: 'action\u0007bell',
    });
    const formatted = failure.format();
    expect(formatted).toContain('message\\u001b[31mred');
    expect(formatted).toContain('action\\u0007bell');
    expect(formatted).not.toContain('\u001b');
    expect(formatted).not.toContain('\u0007');
  });

  it.skipIf(process.platform === 'win32')(
    'escapes a control character in a source filename',
    async () => {
      const repo = await createTempRepo('profile');
      try {
        await writeFile(
          join(repo.root, '.farna/personas/bad\u001b.yaml'),
          'kind: persona\nid: other\ndisplayName: Other\npurpose: Mismatched id.\nresources: []\n',
          'utf8',
        );
        let failure: FarnaError | undefined;
        try {
          await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
        } catch (error) {
          failure = error as FarnaError;
        }
        expect(failure?.code).toBe('F001_INVALID_CONFIG');
        const formatted = failure?.format() ?? '';
        expect(formatted).toContain('bad\\u001b');
        expect(formatted).not.toContain('\u001b');
      } finally {
        await repo.cleanup();
      }
    },
  );

  it('keeps a foreign key with a control character while deleting the owned key', async () => {
    const repo = await generated();
    try {
      const document = await jsonOf(repo, 'opencode.jsonc');
      document['bad\u001bkey'] = 'mine';
      await writeFile(
        join(repo.root, 'opencode.jsonc'),
        `${JSON.stringify(document, null, 2)}\n`,
        'utf8',
      );
      const personaPath = join(repo.root, '.farna/personas/builder.yaml');
      const persona = await readFile(personaPath, 'utf8');
      await writeFile(personaPath, persona.replace('  - mcp/scan\n', ''), 'utf8');

      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.ok).toBe(true);
      // The foreign key is no longer printed in a refusal, so it cannot reach
      // the report unescaped; the edited document still carries it verbatim.
      expect(formatGenerate(result)).not.toContain('\u001b');
      const after = parseJsonc<Record<string, unknown>>(
        await readText(repo.root, 'opencode.jsonc'),
        { subject: 'opencode.jsonc' },
      );
      expect(after['bad\u001bkey']).toBe('mine');
      expect(Object.hasOwn(after, 'mcp')).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it('escapes a control character in a printed warning message', async () => {
    const report = formatCheck({
      ok: true,
      exitCode: 0,
      targets: [
        {
          target: 'opencode',
          mode: 'profile',
          activePersona: 'builder',
          notLive: [],
          checked: [],
          drift: [],
        },
      ],
      checked: [],
      drift: [],
      warnings: [
        {
          code: 'W107_OUTSIDE_OWNERSHIP',
          severity: 'low',
          persona: 'builder',
          target: 'opencode',
          message: 'message\u001b[31mred',
        },
      ],
    });
    expect(report).toContain('message\\u001b[31mred');
    expect(report).not.toContain('\u001b');
  });

  it('escapes a control character in a printed subject', () => {
    const failure = new FarnaError('F001_INVALID_CONFIG', 'subject is unsafe', {
      subject: 'a\u001b[31mb',
    });
    expect(failure.format()).toContain('a\\u001b[31mb');
    expect(failure.format()).not.toContain('\u001b');
  });
});
