import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FarnaError } from '../../src/core/errors.js';
import type { RenderRequest, RenderResult } from '../../src/render/port.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';
import { MutatingRenderTarget, readOutput, writeOutput } from '../support/mutating-renderer.js';
import { createTempRepo, hashTree, readText, type TempRepo } from '../support/temp-repo.js';

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

/** Append a top-level `mode` to an existing persona file. */
async function setMode(repo: TempRepo, persona: string, mode: string): Promise<void> {
  await appendFile(join(repo.root, `.farna/personas/${persona}.yaml`), `mode: ${mode}\n`, 'utf8');
}

async function generate(repo: TempRepo): Promise<Awaited<ReturnType<typeof runGenerate>>> {
  return await runGenerate({ cwd: repo.root, dryRun: false }, new UpstreamRenderTarget());
}

/** Run generate with a renderer that rewrites one emitted agent file. */
async function expectGateFailure(
  repo: TempRepo,
  path: string,
  mutate: (text: string) => string,
): Promise<FarnaError> {
  const before = await hashTree(repo.root);
  const renderer = new MutatingRenderTarget(
    async (request: RenderRequest, result: RenderResult): Promise<RenderResult> => {
      const text = await readOutput(request.outputRoot, path);
      await writeOutput(request.outputRoot, path, mutate(text));
      return result;
    },
  );
  let failure: FarnaError | undefined;
  try {
    await runGenerate({ cwd: repo.root, dryRun: false }, renderer);
  } catch (error) {
    expect(error).toBeInstanceOf(FarnaError);
    failure = error as FarnaError;
  }
  expect(failure?.code).toBe('F008_DECLARED_NOT_EMITTED');
  expect(await hashTree(repo.root)).toBe(before);
  return failure as FarnaError;
}

describe('persona mode', () => {
  it('emits the default subagent when the persona declares no mode', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await generate(repo);
      const builder = frontmatterOf(await readText(repo.root, '.opencode/agents/builder.md'));
      const reviewer = frontmatterOf(await readText(repo.root, '.opencode/agents/reviewer.md'));
      expect(builder['mode']).toBe('subagent');
      expect(reviewer['mode']).toBe('subagent');
    } finally {
      await repo.cleanup();
    }
  });

  it('emits mode primary for the OpenCode 2.x target', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await setMode(repo, 'builder', 'primary');
      const result = await generate(repo);
      const text = await readText(repo.root, '.opencode/agents/builder.md');
      expect(frontmatterOf(text)['mode']).toBe('primary');
      expect(text).toContain('\nmode: primary\n');
      // A persona that does not declare a mode keeps the default.
      expect(frontmatterOf(await readText(repo.root, '.opencode/agents/reviewer.md'))['mode']).toBe(
        'subagent',
      );
      expect(result.warnings.map((entry) => entry.code)).not.toContain('W117_PERSONA_MODE_IGNORED');
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('emits mode primary for the OpenCode 1.x target', async () => {
    const repo = await createTempRepo('profile-v1');
    try {
      await setMode(repo, 'builder', 'primary');
      await generate(repo);
      const text = await readText(repo.root, '.opencode/agents/builder.md');
      expect(frontmatterOf(text)['mode']).toBe('primary');
      expect(text).toContain('\nmode: primary\n');
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('carries the all mode unchanged on both OpenCode targets', async () => {
    for (const fixture of ['opencode', 'profile-v1'] as const) {
      const repo = await createTempRepo(fixture);
      try {
        await setMode(repo, 'builder', 'all');
        await generate(repo);
        expect(
          frontmatterOf(await readText(repo.root, '.opencode/agents/builder.md'))['mode'],
        ).toBe('all');
      } finally {
        await repo.cleanup();
      }
    }
  });

  it('inherits a base mode and lets the child override it', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await setMode(repo, 'builder', 'primary');
      await writeFile(
        join(repo.root, '.farna/personas/builder-plus.yaml'),
        'kind: persona\nid: builder-plus\ndisplayName: Builder Plus\npurpose: Inherits the base mode.\nextends: builder\nresources: []\n',
        'utf8',
      );
      await writeFile(
        join(repo.root, '.farna/personas/builder-override.yaml'),
        'kind: persona\nid: builder-override\ndisplayName: Builder Override\npurpose: Overrides the base mode.\nextends: builder\nmode: subagent\nresources: []\n',
        'utf8',
      );
      await generate(repo);
      expect(
        frontmatterOf(await readText(repo.root, '.opencode/agents/builder-plus.md'))['mode'],
      ).toBe('primary');
      expect(
        frontmatterOf(await readText(repo.root, '.opencode/agents/builder-override.md'))['mode'],
      ).toBe('subagent');
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses an unknown mode at the source boundary', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await setMode(repo, 'builder', 'boss');
      let failure: FarnaError | undefined;
      try {
        await generate(repo);
      } catch (error) {
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F001_INVALID_CONFIG');
      expect(failure?.subject).toBe('.farna/personas/builder.yaml');
      expect(failure?.message).toContain('mode');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects an emitted mode that does not match the persona', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await setMode(repo, 'builder', 'primary');
      await generate(repo);
      const failure = await expectGateFailure(repo, '.opencode/agents/builder.md', (text) =>
        text.replace('mode: primary', 'mode: subagent'),
      );
      expect(failure.message).toContain('"mode"');
      expect(failure.message).toContain('primary');
    } finally {
      await repo.cleanup();
    }
  });
});

describe('persona mode on Claude Code', () => {
  it('warns W117 for a declared mode, writes no mode key and still checks clean', async () => {
    const repo = await createTempRepo('composed');
    try {
      // `builder-python` extends `builder`, so it inherits the declared mode and
      // must be reported under its own id.
      await setMode(repo, 'builder', 'primary');
      const result = await generate(repo);
      const modeWarnings = result.warnings.filter(
        (entry) => entry.code === 'W117_PERSONA_MODE_IGNORED',
      );
      expect(modeWarnings.map((entry) => entry.persona).sort()).toEqual([
        'builder',
        'builder-python',
      ]);
      for (const entry of modeWarnings) {
        expect(entry.target).toBe('claudecode');
        expect(entry.severity).toBe('info');
        expect(entry.message).toContain(entry.persona);
        expect(entry.message).toContain('claudecode');
        expect(entry.message).toContain('primary');
      }
      for (const persona of ['builder', 'builder-python']) {
        const text = await readText(repo.root, `.claude/agents/${persona}.md`);
        const frontmatter = frontmatterOf(text);
        expect(Object.hasOwn(frontmatter, 'mode')).toBe(false);
        expect(text).not.toContain('mode: primary');
      }

      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
      expect(check.warnings.map((entry) => entry.code)).toContain('W117_PERSONA_MODE_IGNORED');
      const reportedPersonas = check.warnings
        .filter((entry) => entry.code === 'W117_PERSONA_MODE_IGNORED')
        .map((entry) => entry.persona)
        .sort();
      expect(reportedPersonas).toEqual(['builder', 'builder-python']);
    } finally {
      await repo.cleanup();
    }
  });

  it('warns for the persona that declares the mode, not for one that does not', async () => {
    const repo = await createTempRepo('demo');
    try {
      await setMode(repo, 'reviewer', 'all');
      const result = await generate(repo);
      const modeWarnings = result.warnings.filter(
        (entry) => entry.code === 'W117_PERSONA_MODE_IGNORED',
      );
      expect(modeWarnings).toHaveLength(1);
      expect(modeWarnings[0]?.persona).toBe('reviewer');
      expect(modeWarnings[0]?.message).toContain('all');
      const builder = frontmatterOf(await readText(repo.root, '.claude/agents/builder.md'));
      expect(Object.hasOwn(builder, 'mode')).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a mode key the renderer invents on Claude Code', async () => {
    const repo = await createTempRepo('demo');
    try {
      await generate(repo);
      const failure = await expectGateFailure(repo, '.claude/agents/builder.md', (text) =>
        text.replace('---\n', '---\nmode: primary\n'),
      );
      expect(failure.message).toContain('undeclared key "mode"');
    } finally {
      await repo.cleanup();
    }
  });
});
