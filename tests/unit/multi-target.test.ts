import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
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

const PERSONAS = ['builder', 'reviewer'] as const;

/** A config with `claudecode` and `opencode` in agent mode, both model-mapped. */
const BOTH_TARGETS = [
  '{',
  '  "schemaVersion": 1,',
  '  "targets": { "claudecode": {}, "opencode": {} },',
  '  "models": {',
  '    "standard": {',
  '      "claudecode": "claude-sonnet-4-5",',
  '      "opencode": "anthropic/claude-sonnet-4-5"',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const CLAUDECODE_ONLY = [
  '{',
  '  "schemaVersion": 1,',
  '  "targets": { "claudecode": {} },',
  '  "models": { "standard": { "claudecode": "claude-sonnet-4-5" } }',
  '}',
  '',
].join('\n');

const OPENCODE_ONLY = [
  '{',
  '  "schemaVersion": 1,',
  '  "targets": { "opencode": {} },',
  '  "models": { "standard": { "opencode": "anthropic/claude-sonnet-4-5" } }',
  '}',
  '',
].join('\n');

async function repoWith(config: string): Promise<TempRepo> {
  const repo = await createTempRepo('demo');
  await writeFile(join(repo.root, '.farna/config.jsonc'), config, 'utf8');
  return repo;
}

type LockShape = {
  schemaVersion: number;
  targets: Record<string, { files: Array<{ path: string }> }>;
};

async function lockOf(root: string): Promise<LockShape> {
  return JSON.parse(await readText(root, '.farna/lock.json')) as LockShape;
}

describe('two configured targets in one run', () => {
  it('generates both targets, records one lock entry each, checks clean and is idempotent', async () => {
    const repo = await repoWith(BOTH_TARGETS);
    try {
      const first = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(first.targets.map((target) => target.target)).toEqual(['claudecode', 'opencode']);

      const lock = await lockOf(repo.root);
      expect(lock.schemaVersion).toBe(2);
      expect(Object.keys(lock.targets)).toEqual(['claudecode', 'opencode']);
      const recorded = Object.values(lock.targets).flatMap((entry) =>
        entry.files.map((file) => file.path),
      );
      expect(recorded).toContain('.claude/agents/builder.md');
      expect(recorded).toContain('.opencode/agents/builder.md');
      expect(recorded.some((path) => path.startsWith('.claude/'))).toBe(true);
      expect(recorded.some((path) => path.startsWith('.opencode/'))).toBe(true);

      const files = await listFiles(repo.root);
      for (const persona of PERSONAS) {
        expect(files).toContain(`.claude/agents/${persona}.md`);
        expect(files).toContain(`.opencode/agents/${persona}.md`);
      }

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.exitCode).toBe(0);
      expect(check.targets.map((target) => target.target)).toEqual(['claudecode', 'opencode']);

      const before = await hashTree(repo.root);
      const second = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(
        second.targets
          .flatMap((target) => target.files)
          .every((file) => file.status === 'unchanged'),
      ).toBe(true);
      expect(second.files.every((file) => file.status === 'unchanged')).toBe(true);
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  }, 60_000);

  it('N renders equal N single-target runs, byte for byte', async () => {
    const combined = await repoWith(BOTH_TARGETS);
    const claudeOnly = await repoWith(CLAUDECODE_ONLY);
    const opencodeOnly = await repoWith(OPENCODE_ONLY);
    try {
      await runGenerate({ cwd: combined.root, dryRun: false }, new UpstreamRenderTarget());
      await runGenerate({ cwd: claudeOnly.root, dryRun: false }, new UpstreamRenderTarget());
      await runGenerate({ cwd: opencodeOnly.root, dryRun: false }, new UpstreamRenderTarget());

      for (const persona of PERSONAS) {
        expect(await readText(combined.root, `.claude/agents/${persona}.md`)).toBe(
          await readText(claudeOnly.root, `.claude/agents/${persona}.md`),
        );
        expect(await readText(combined.root, `.opencode/agents/${persona}.md`)).toBe(
          await readText(opencodeOnly.root, `.opencode/agents/${persona}.md`),
        );
      }
    } finally {
      await combined.cleanup();
      await claudeOnly.cleanup();
      await opencodeOnly.cleanup();
    }
  }, 60_000);

  it('removes a removed target recorded output and leaves the other target intact', async () => {
    const repo = await repoWith(BOTH_TARGETS);
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
      // Read the other target's bytes before the switch, so the assertion is
      // that the remaining target was not rewritten to something else.
      const kept = await readText(repo.root, '.claude/agents/builder.md');

      const configPath = join(repo.root, '.farna/config.jsonc');
      await writeFile(configPath, CLAUDECODE_ONLY, 'utf8');
      await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());

      const files = await listFiles(repo.root);
      for (const persona of PERSONAS) {
        expect(files).not.toContain(`.opencode/agents/${persona}.md`);
        expect(files).toContain(`.claude/agents/${persona}.md`);
      }
      expect(await readText(repo.root, '.claude/agents/builder.md')).toBe(kept);

      const lock = await lockOf(repo.root);
      expect(Object.keys(lock.targets)).toEqual(['claudecode']);
      const recorded = lock.targets['claudecode']?.files.map((file) => file.path) ?? [];
      expect(recorded.some((path) => path.startsWith('.opencode/'))).toBe(false);

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 60_000);

  it('applies --persona to every configured target and emits no W118', async () => {
    const repo = await repoWith(BOTH_TARGETS);
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false, persona: 'builder' },
        new UpstreamRenderTarget(),
      );
      const [claude, opencode] = result.targets;
      // Both targets support profile mode now, so the flag applies to both and
      // the "flag ignored" warning is unreachable.
      expect(claude).toMatchObject({
        target: 'claudecode',
        mode: 'profile',
        activePersona: 'builder',
        notLive: ['reviewer'],
      });
      expect(claude?.personas).toEqual(['builder']);
      expect(opencode).toMatchObject({
        target: 'opencode',
        mode: 'profile',
        activePersona: 'builder',
        notLive: ['reviewer'],
      });
      expect(opencode?.personas).toEqual(['builder']);

      expect(
        result.warnings.filter((entry) => entry.code === 'W118_PERSONA_FLAG_NOT_APPLIED'),
      ).toHaveLength(0);

      const files = await listFiles(repo.root);
      expect(files).toContain('.claude/agents/builder.md');
      expect(files).not.toContain('.claude/agents/reviewer.md');
      // The demo persona declares a rule, so profile mode owns the instruction
      // region as well as the agent file.
      expect(files).toContain('CLAUDE.md');
      expect(files).toContain('.opencode/agents/builder.md');
      expect(files).not.toContain('.opencode/agents/reviewer.md');

      const check = await runCheck(repo.root, new UpstreamRenderTarget(), { persona: 'builder' });
      expect(check.ok).toBe(true);
      expect(check.exitCode).toBe(0);
      expect(check.targets.map((target) => [target.target, target.mode])).toEqual([
        ['claudecode', 'profile'],
        ['opencode', 'profile'],
      ]);
      expect(check.warnings.map((entry) => entry.code)).not.toContain(
        'W118_PERSONA_FLAG_NOT_APPLIED',
      );
    } finally {
      await repo.cleanup();
    }
  }, 60_000);

  it('records the same profile mode for both targets and keeps W118 out of the lockfile', async () => {
    const repo = await repoWith(BOTH_TARGETS);
    try {
      await runGenerate(
        { cwd: repo.root, dryRun: false, persona: 'builder' },
        new UpstreamRenderTarget(),
      );
      const raw = await readText(repo.root, '.farna/lock.json');
      // The warning describes the invocation, not the source: a lockfile built
      // from source warnings only must never carry it.
      expect(raw).not.toContain('W118');
      const lock = JSON.parse(raw) as {
        targets: Record<
          string,
          {
            mode: string;
            activePersona: string | null;
            notLive: string[];
            files: Array<{ path: string }>;
          }
        >;
      };
      expect(Object.keys(lock.targets)).toEqual(['claudecode', 'opencode']);
      expect(lock.targets['claudecode']).toMatchObject({
        mode: 'profile',
        activePersona: 'builder',
        notLive: ['reviewer'],
      });
      expect(lock.targets['opencode']).toMatchObject({
        mode: 'profile',
        activePersona: 'builder',
        notLive: ['reviewer'],
      });
      expect(lock.targets['claudecode']?.files.map((file) => file.path)).toEqual([
        '.claude/agents/builder.md',
        'CLAUDE.md',
      ]);
      expect(lock.targets['opencode']?.files.map((file) => file.path)).toEqual([
        '.opencode/agents/builder.md',
      ]);
    } finally {
      await repo.cleanup();
    }
  }, 60_000);

  it('accepts --persona on a claudecode-only config and renders its profile', async () => {
    const repo = await repoWith(CLAUDECODE_ONLY);
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false, persona: 'builder' },
        new UpstreamRenderTarget(),
      );
      const [claude] = result.targets;
      expect(claude).toMatchObject({
        target: 'claudecode',
        mode: 'profile',
        activePersona: 'builder',
        notLive: ['reviewer'],
      });
      expect(claude?.personas).toEqual(['builder']);
      const files = await listFiles(repo.root);
      expect(files).toContain('.claude/agents/builder.md');
      expect(files).toContain('CLAUDE.md');
      expect(files).not.toContain('.claude/agents/reviewer.md');
      expect(
        await runCheck(repo.root, new UpstreamRenderTarget(), { persona: 'builder' }),
      ).toMatchObject({ ok: true, exitCode: 0 });
    } finally {
      await repo.cleanup();
    }
  }, 60_000);

  it('refuses --persona naming no persona on a mixed config, naming the target and the id', async () => {
    const repo = await repoWith(BOTH_TARGETS);
    const before = await hashTree(repo.root);
    try {
      let failure: FarnaError | undefined;
      try {
        await runGenerate(
          { cwd: repo.root, dryRun: false, persona: 'ghost' },
          new UpstreamRenderTarget(),
        );
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F001_INVALID_CONFIG');
      expect(failure?.exitCode).toBe(1);
      expect(failure?.subject).toBe('--persona');
      // One refusal, and it says which target could not resolve the id: every
      // configured target resolves the same id, and the first reports it.
      expect(failure?.message).toContain('"ghost"');
      expect(failure?.message).toContain('claudecode');
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  }, 60_000);

  it('names the profile target when the live persona declares a reference it cannot carry', async () => {
    // `composed` declares a permission resource that opts into a tool
    // allow-list, which only Claude Code can express. In a mixed run the
    // claudecode target accepts it and the profile OpenCode target refuses it,
    // so the refusal must say which target failed.
    const repo = await createTempRepo('composed');
    try {
      await writeFile(
        join(repo.root, '.farna/config.jsonc'),
        [
          '{',
          '  "schemaVersion": 1,',
          '  "targets": { "claudecode": {}, "opencode": {} },',
          '  "models": {',
          '    "standard": {',
          '      "claudecode": "claude-sonnet-4-5",',
          '      "opencode": "anthropic/claude-sonnet-4-5"',
          '    },',
          '    "fast": {',
          '      "claudecode": "claude-haiku-4-5",',
          '      "opencode": "anthropic/claude-haiku-4-5"',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      const before = await hashTree(repo.root);
      let failure: FarnaError | undefined;
      try {
        await runGenerate(
          { cwd: repo.root, dryRun: false, persona: 'builder-python' },
          new UpstreamRenderTarget(),
        );
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F001_INVALID_CONFIG');
      expect(failure?.message).toContain('allow-list');
      expect(failure?.message).toContain('opencode');
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  }, 60_000);
});
