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

  it('refuses --persona on a mixed config as a typed error, with zero writes (slice 3 owns the semantics)', async () => {
    const repo = await repoWith(BOTH_TARGETS);
    try {
      const before = await hashTree(repo.root);
      let failure: FarnaError | undefined;
      try {
        await runGenerate(
          { cwd: repo.root, dryRun: false, persona: 'builder' },
          new UpstreamRenderTarget(),
        );
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        failure = error as FarnaError;
      }
      // Today `--persona` is refused on the claudecode target, which does not
      // support profile mode. It is a typed F001, never an uncaught crash.
      expect(failure?.code).toBe('F001_INVALID_CONFIG');
      expect(failure?.message).toContain('claudecode');
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  }, 60_000);
});
