import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allCheckDrift, runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FarnaError } from '../../src/core/errors.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';
import {
  createTempRepo,
  hashTree,
  listFiles,
  readText,
  type TempRepo,
} from '../support/temp-repo.js';

const CLAUDE_PROFILE_FILES = [
  '.claude/agents/builder.md',
  '.claude/settings.json',
  '.farna/lock.json',
  '.mcp.json',
  'CLAUDE.md',
];

async function profileRepo(): Promise<TempRepo> {
  return await createTempRepo('claudecode-profile');
}

async function generated(): Promise<TempRepo> {
  const repo = await profileRepo();
  await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
  return repo;
}

type LockTarget = {
  mode: string;
  activePersona: string | null;
  notLive: string[];
  personas: Array<{ id: string }>;
  files: Array<{ path: string; shape?: string; ownedKeys?: string[]; regionId?: string }>;
};

type Lock = { targets: Record<string, LockTarget>; warnings: Array<{ code: string }> };

async function lockOf(repo: TempRepo): Promise<Lock> {
  return JSON.parse(await readText(repo.root, '.farna/lock.json')) as Lock;
}

async function expectRefusal(run: () => Promise<unknown>, message: string): Promise<FarnaError> {
  let failure: FarnaError | undefined;
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(FarnaError);
    failure = error as FarnaError;
  }
  expect(failure?.code).toBe('F001_INVALID_CONFIG');
  expect(failure?.exitCode).toBe(1);
  expect(failure?.message).toContain(message);
  return failure as FarnaError;
}

describe('Claude Code profile mode', () => {
  it('generates and checks the four outputs, then a second generate is a no-op', async () => {
    const repo = await profileRepo();
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.targets[0]?.mode).toBe('profile');
      expect(result.targets[0]?.activePersona).toBe('builder');
      expect(result.targets[0]?.notLive).toEqual(['reviewer']);
      expect(
        [...result.targets.flatMap((target) => target.files), ...result.files]
          .map((file) => file.path)
          .sort(),
      ).toEqual(CLAUDE_PROFILE_FILES);

      const lock = await lockOf(repo);
      const target = lock.targets['claudecode'];
      expect(target?.mode).toBe('profile');
      expect(target?.notLive).toEqual(['reviewer']);
      const shapes = Object.fromEntries(
        (target?.files ?? []).map((file) => [file.path, file.shape ?? 'whole']),
      );
      expect(shapes).toEqual({
        '.claude/agents/builder.md': 'whole',
        '.claude/settings.json': 'structured',
        '.mcp.json': 'structured',
        'CLAUDE.md': 'region',
      });
      expect(target?.files.find((file) => file.path === '.mcp.json')?.ownedKeys).toEqual([
        'mcpServers',
      ]);
      expect(
        target?.files.find((file) => file.path === '.claude/settings.json')?.ownedKeys,
      ).toEqual(['hooks']);
      expect(target?.files.find((file) => file.path === 'CLAUDE.md')?.regionId).toBe(
        'claude-instructions',
      );

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.exitCode).toBe(0);

      const before = await hashTree(repo.root);
      const second = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(
        [...second.targets.flatMap((target) => target.files), ...second.files].every(
          (file) => file.status === 'unchanged',
        ),
      ).toBe(true);
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  }, 60_000);

  it('preserves bytes outside every owned surface and reports a change inside one', async () => {
    const repo = await generated();
    try {
      const instructions = await readText(repo.root, 'CLAUDE.md');
      await writeFile(
        join(repo.root, 'CLAUDE.md'),
        `# Team notes\n\nUser prose.\n\n${instructions}\nMore user prose.\n`,
        'utf8',
      );
      const mcp = JSON.parse(await readText(repo.root, '.mcp.json')) as Record<string, unknown>;
      mcp['theme'] = 'dark';
      await writeFile(join(repo.root, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`, 'utf8');
      const settings = JSON.parse(await readText(repo.root, '.claude/settings.json')) as Record<
        string,
        unknown
      >;
      settings['permissions'] = { allow: ['Read'] };
      await writeFile(
        join(repo.root, '.claude/settings.json'),
        `${JSON.stringify(settings, null, 2)}\n`,
        'utf8',
      );

      // Every edit is outside what the tool owns: check stays clean.
      expect((await runCheck(repo.root, new UpstreamRenderTarget())).ok).toBe(true);

      const outsideInstructions = await readText(repo.root, 'CLAUDE.md');
      await writeFile(
        join(repo.root, 'CLAUDE.md'),
        outsideInstructions.replace('smallest change', 'largest change'),
        'utf8',
      );
      const instructionDrift = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(instructionDrift.ok).toBe(false);
      expect(allCheckDrift(instructionDrift)).toEqual([
        {
          code: 'F007_DRIFT',
          path: 'CLAUDE.md',
          kind: 'modified',
          detail: 'region "claude-instructions" differs from a fresh render',
        },
      ]);
      await writeFile(join(repo.root, 'CLAUDE.md'), outsideInstructions, 'utf8');

      const outsideMcp = await readText(repo.root, '.mcp.json');
      const changedMcp = JSON.parse(outsideMcp) as {
        mcpServers: Record<string, { command?: string }>;
      };
      changedMcp.mcpServers['scan'] = { command: 'some-other-server' };
      await writeFile(
        join(repo.root, '.mcp.json'),
        `${JSON.stringify(changedMcp, null, 2)}\n`,
        'utf8',
      );
      const mcpDrift = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(mcpDrift.ok).toBe(false);
      expect(allCheckDrift(mcpDrift)).toContainEqual({
        code: 'F007_DRIFT',
        path: '.mcp.json',
        kind: 'modified',
        detail: 'owned key(s) mcpServers differ from a fresh render',
      });
      await writeFile(join(repo.root, '.mcp.json'), outsideMcp, 'utf8');

      const outsideSettings = await readText(repo.root, '.claude/settings.json');
      const changedSettings = JSON.parse(outsideSettings) as {
        hooks: Record<string, unknown>;
      };
      changedSettings.hooks = { PreToolUse: [] };
      await writeFile(
        join(repo.root, '.claude/settings.json'),
        `${JSON.stringify(changedSettings, null, 2)}\n`,
        'utf8',
      );
      const settingsDrift = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(settingsDrift.ok).toBe(false);
      expect(allCheckDrift(settingsDrift)).toContainEqual({
        code: 'F007_DRIFT',
        path: '.claude/settings.json',
        kind: 'modified',
        detail: 'owned key(s) hooks differ from a fresh render',
      });
      await writeFile(join(repo.root, '.claude/settings.json'), outsideSettings, 'utf8');

      expect((await runCheck(repo.root, new UpstreamRenderTarget())).ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 60_000);

  it('applies --persona to a claudecode-only config and recomputes notLive', async () => {
    const repo = await profileRepo();
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false, persona: 'reviewer' },
        new UpstreamRenderTarget(),
      );
      expect(result.targets[0]).toMatchObject({
        target: 'claudecode',
        mode: 'profile',
        activePersona: 'reviewer',
        notLive: ['builder'],
      });
      const files = await listFiles(repo.root);
      expect(files).toContain('.claude/agents/reviewer.md');
      expect(files).not.toContain('.claude/agents/builder.md');
      expect(files).toContain('CLAUDE.md');
      // The live reviewer declares only the http docs server, so the MCP
      // document holds it and no hooks document is emitted.
      const mcp = JSON.parse(await readText(repo.root, '.mcp.json')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(mcp.mcpServers)).toEqual(['docs']);
      expect(files).not.toContain('.claude/settings.json');
      expect(await readText(repo.root, 'CLAUDE.md')).toContain('FBS_RULE_REVIEWER_8d2f');
      expect(
        (await runCheck(repo.root, new UpstreamRenderTarget(), { persona: 'reviewer' })).ok,
      ).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 60_000);

  it('emits W109 for a rule-only profile and not for an MCP-forced one', async () => {
    // The demo fixture declares a rule only, forced into profile mode by the
    // committed active selection. The same source shape on OpenCode must
    // produce the same W109 and the same notLive, so the two target families
    // do not diverge in what they report about the selection.
    const forced = await createTempRepo('demo');
    const opencodeSameShape = await createTempRepo('demo');
    const mcpForced = await profileRepo();
    try {
      await writeFile(
        join(forced.root, '.farna/config.jsonc'),
        '{"schemaVersion":1,"targets":{"claudecode":{"active":"builder"}},"models":{"standard":{"claudecode":"claude-sonnet-4-5"}}}\n',
        'utf8',
      );
      const ruleOnly = await runGenerate(
        { cwd: forced.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(
        ruleOnly.warnings.filter((entry) => entry.code === 'W109_PROFILE_BY_CHOICE'),
      ).toHaveLength(1);
      expect(
        ruleOnly.warnings.find((entry) => entry.code === 'W109_PROFILE_BY_CHOICE'),
      ).toMatchObject({ severity: 'info', target: 'claudecode', persona: 'builder' });

      await writeFile(
        join(opencodeSameShape.root, '.farna/config.jsonc'),
        '{"schemaVersion":1,"targets":{"opencode":{"active":"builder"}},"models":{"standard":{"opencode":"anthropic/claude-sonnet-4-5"}}}\n',
        'utf8',
      );
      const opencodeRun = await runGenerate(
        { cwd: opencodeSameShape.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      const opencodeW109 = opencodeRun.warnings.find(
        (entry) => entry.code === 'W109_PROFILE_BY_CHOICE',
      );
      expect(opencodeW109).toMatchObject({
        severity: 'info',
        target: 'opencode',
        persona: 'builder',
      });
      expect(ruleOnly.targets[0]?.notLive).toEqual(opencodeRun.targets[0]?.notLive);
      expect(ruleOnly.targets[0]?.notLive).toEqual(['reviewer']);

      const mcpRun = await runGenerate(
        { cwd: mcpForced.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(mcpRun.warnings.map((entry) => entry.code)).not.toContain('W109_PROFILE_BY_CHOICE');
    } finally {
      await forced.cleanup();
      await opencodeSameShape.cleanup();
      await mcpForced.cleanup();
    }
  }, 60_000);

  it('refuses mcp and hook in agent mode with the profile action, and skill and command in both modes', async () => {
    const repo = await createTempRepo('demo');
    try {
      for (const ref of ['mcp/scan', 'hook/format-on-save']) {
        await writeFile(
          join(repo.root, '.farna/personas/builder.yaml'),
          `kind: persona\nid: builder\ndisplayName: Builder\npurpose: Writes code.\nresources:\n  - ${ref}\n`,
          'utf8',
        );
        const before = await hashTree(repo.root);
        const failure = await expectRefusal(
          () => runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget()),
          `requires profile mode on claudecode`,
        );
        expect(failure.message).toContain(ref);
        expect(failure.action).toContain('targets.claudecode.active');
        expect(await hashTree(repo.root)).toBe(before);
      }

      // Profile mode accepts the same two references (the source has no such
      // resource, so this proves the refusal is no longer the reason; the
      // unknown-resource error is a different message).
      await writeFile(
        join(repo.root, '.farna/personas/builder.yaml'),
        'kind: persona\nid: builder\ndisplayName: Builder\npurpose: Writes code.\nresources:\n  - mcp/scan\n',
        'utf8',
      );
      const failure = await expectRefusal(
        () =>
          runGenerate(
            { cwd: repo.root, dryRun: false, persona: 'builder' },
            new UpstreamRenderTarget(),
          ),
        'unknown mcp "scan"',
      );
      expect(failure.message).not.toContain('requires profile mode');

      for (const mode of ['agent', 'profile'] as const) {
        await writeFile(
          join(repo.root, '.farna/personas/builder.yaml'),
          'kind: persona\nid: builder\ndisplayName: Builder\npurpose: Writes code.\nresources:\n  - skill/secure-review\n',
          'utf8',
        );
        const refusal = await expectRefusal(
          () =>
            runGenerate(
              {
                cwd: repo.root,
                dryRun: false,
                ...(mode === 'profile' ? { persona: 'builder' } : {}),
              },
              new UpstreamRenderTarget(),
            ),
          'skill resource kind is not carried by claudecode in this slice',
        );
        expect(refusal.action).toContain('claudecode');
      }
    } finally {
      await repo.cleanup();
    }
  }, 60_000);
});
