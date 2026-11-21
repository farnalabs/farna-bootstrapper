import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { runInit } from '../../src/cli/commands/init.js';
import { resolveSource } from '../../src/compose/resolve.js';
import { loadConfig } from '../../src/config/load.js';
import { FarnaError } from '../../src/core/errors.js';
import { loadSource } from '../../src/source/load.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createEmptyTempDir, createTempRepo } from '../support/temp-repo.js';

async function expectFarnaError(promise: Promise<unknown>, code: string): Promise<FarnaError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FarnaError);
    const farna = error as FarnaError;
    expect(farna.code).toBe(code);
    return farna;
  }
  throw new Error(`expected ${code} but nothing was thrown`);
}

describe('source loader', () => {
  it('parses the fixture config, personas and rule bodies', async () => {
    const repo = await createTempRepo();
    try {
      const config = await loadConfig(repo.root);
      expect(config.schemaVersion).toBe(1);
      expect(Object.keys(config.targets)).toEqual(['claudecode']);
      expect(config.models?.['standard']?.['claudecode']).toBe('claude-sonnet-4-5');

      const source = await loadSource(repo.root);
      expect(source.personas.map((persona) => persona.id)).toEqual(['builder', 'reviewer']);
      expect(source.rules.map((rule) => rule.id)).toEqual(['house-style', 'review-checklist']);

      const resolved = resolveSource(source, config);
      const builder = resolved.personas.find((persona) => persona.id === 'builder');
      const reviewer = resolved.personas.find((persona) => persona.id === 'reviewer');
      expect(builder?.model).toBe('claude-sonnet-4-5');
      expect(builder?.rules.map((rule) => rule.id)).toEqual(['house-style']);
      expect(builder?.rules[0]?.body).toContain('FBS_RULE_BUILDER_4a1c');
      expect(reviewer?.rules[0]?.body).toContain('FBS_RULE_REVIEWER_8d2f');
      expect(builder?.digest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects an unknown config key', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/config.jsonc'),
        '{"schemaVersion":1,"targets":{"claudecode":{}},"status":"promised"}\n',
        'utf8',
      );
      const error = await expectFarnaError(loadConfig(repo.root), 'F001_INVALID_CONFIG');
      expect(error.subject).toContain('config.jsonc');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a duplicate config key', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/config.jsonc'),
        '{"schemaVersion":1,"schemaVersion":1,"targets":{"claudecode":{}}}\n',
        'utf8',
      );
      const error = await expectFarnaError(loadConfig(repo.root), 'F001_INVALID_CONFIG');
      expect(error.message).toContain('duplicate key "schemaVersion"');
    } finally {
      await repo.cleanup();
    }
  });

  for (const [label, relative, load] of [
    ['a persona', '.farna/personas/builder.yaml', loadSource],
    ['a rule', '.farna/resources/rules/house-style.md', loadSource],
    ['a permission', '.farna/resources/permissions/builder-default.jsonc', loadSource],
    ['the config', '.farna/config.jsonc', loadConfig],
  ] as const) {
    it(`refuses invalid UTF-8 in ${label} with the file and offset`, async () => {
      const repo = await createTempRepo('composed');
      try {
        // 0xE9 is a three-byte lead at EOF: a lone byte the utf8 decoder must
        // never replace with U+FFFD.
        await writeFile(join(repo.root, relative), Buffer.from([0xe9]));
        const error = await expectFarnaError(load(repo.root), 'F001_INVALID_CONFIG');
        expect(error.subject).toBe(relative);
        expect(error.message).toContain('not valid UTF-8');
        expect(error.message).toContain('byte offset 0');
      } finally {
        await repo.cleanup();
      }
    });
  }

  it('refuses invalid UTF-8 after valid bytes at the exact offset', async () => {
    const repo = await createTempRepo();
    try {
      const prefix =
        'kind: persona\nid: builder\ndisplayName: Builder\npurpose: Writes code.\nresources: []\n';
      await writeFile(
        join(repo.root, '.farna/personas/builder.yaml'),
        Buffer.concat([Buffer.from(prefix, 'utf8'), Buffer.from([0xe9, 0x0a])]),
      );
      const error = await expectFarnaError(loadSource(repo.root), 'F001_INVALID_CONFIG');
      expect(error.message).toContain(`byte offset ${prefix.length}`);
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a config that starts with a BOM', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/config.jsonc'),
        `\uFEFF{"schemaVersion":1,"targets":{"claudecode":{}}}\n`,
        'utf8',
      );
      const error = await expectFarnaError(loadConfig(repo.root), 'F001_INVALID_CONFIG');
      expect(error.message).toContain('BOM');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a persona id that does not match the file name', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/personas/other.yaml'),
        'kind: persona\nid: builder\ndisplayName: Other\npurpose: Another builder.\nresources: []\n',
        'utf8',
      );
      const error = await expectFarnaError(loadSource(repo.root), 'F001_INVALID_CONFIG');
      expect(error.message).toContain('does not match the file name');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a persona reference to a missing rule', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/personas/reviewer.yaml'),
        'kind: persona\nid: reviewer\ndisplayName: Reviewer\npurpose: Reviews a change.\nresources:\n  - rule/nope\n',
        'utf8',
      );
      const config = await loadConfig(repo.root);
      const source = await loadSource(repo.root);
      const error = await expectFarnaError(
        Promise.resolve().then(() => resolveSource(source, config)),
        'F001_INVALID_CONFIG',
      );
      expect(error.message).toContain('unknown rule "nope"');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a persona file with more than one YAML document', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/personas/reviewer.yaml'),
        [
          'kind: persona',
          'id: reviewer',
          'displayName: Reviewer',
          'purpose: Reviews a change.',
          'resources: []',
          '---',
          'kind: persona',
          'id: evil',
          'displayName: Evil',
          'purpose: The second persona is never read.',
          'resources: []',
          '',
        ].join('\n'),
        'utf8',
      );
      const error = await expectFarnaError(loadSource(repo.root), 'F001_INVALID_CONFIG');
      expect(error.message).toContain('2 YAML documents');
      expect(error.subject).toBe('.farna/personas/reviewer.yaml');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a rule frontmatter description, which nothing would emit', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/resources/rules/house-style.md'),
        [
          '---',
          'kind: rule',
          'id: house-style',
          'displayName: House style',
          'description: Accepted and ignored before this fix.',
          '---',
          '',
          'FBS_RULE_BUILDER_4a1c',
          '',
        ].join('\n'),
        'utf8',
      );
      const error = await expectFarnaError(loadSource(repo.root), 'F001_INVALID_CONFIG');
      expect(error.message).toContain('description');
    } finally {
      await repo.cleanup();
    }
  });

  it('allows two personas to share a display name, which is never emitted', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/personas/reviewer.yaml'),
        'kind: persona\nid: reviewer\ndisplayName: Builder\npurpose: Reviews a change.\nresources:\n  - rule/review-checklist\n',
        'utf8',
      );
      const source = await loadSource(repo.root);
      expect(source.personas.map((persona) => persona.displayName)).toEqual(['Builder', 'Builder']);
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects an unsupported resource kind', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/personas/reviewer.yaml'),
        'kind: persona\nid: reviewer\ndisplayName: Reviewer\npurpose: Reviews a change.\nresources:\n  - skill/secure-review\n',
        'utf8',
      );
      const config = await loadConfig(repo.root);
      const source = await loadSource(repo.root);
      const error = await expectFarnaError(
        Promise.resolve().then(() => resolveSource(source, config)),
        'F001_INVALID_CONFIG',
      );
      expect(error.message).toContain('not implemented in this slice');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a resource directory this slice does not implement', async () => {
    const repo = await createTempRepo();
    try {
      await mkdir(join(repo.root, '.farna/resources/skills'), { recursive: true });
      const error = await expectFarnaError(loadSource(repo.root), 'F001_INVALID_CONFIG');
      expect(error.message).toContain('resource kind "skills" is not implemented');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a YAML anchor or alias in a persona file', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/personas/reviewer.yaml'),
        'kind: persona\nid: reviewer\ndisplayName: &name Reviewer\npurpose: Reviews a change.\nresources:\n  - rule/review-checklist\n',
        'utf8',
      );
      const error = await expectFarnaError(loadSource(repo.root), 'F001_INVALID_CONFIG');
      expect(error.message).toContain('anchors are not allowed');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a targets key this slice does not implement', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/config.jsonc'),
        '{"schemaVersion":1,"targets":{"opencode":{}}}\n',
        'utf8',
      );
      const error = await expectFarnaError(loadConfig(repo.root), 'F001_INVALID_CONFIG');
      expect(error.message).toContain('this slice supports only: claudecode');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a model class mapped for a target that is not configured', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/config.jsonc'),
        '{"schemaVersion":1,"targets":{"claudecode":{}},"models":{"standard":{"opencode":"x"}}}\n',
        'utf8',
      );
      const error = await expectFarnaError(loadConfig(repo.root), 'F001_INVALID_CONFIG');
      expect(error.message).toContain('target "opencode" is not configured');
    } finally {
      await repo.cleanup();
    }
  });

  it('ignores OS metadata files that a desktop checkout writes', async () => {
    const repo = await createTempRepo('composed');
    try {
      for (const name of ['.DS_Store', 'Thumbs.db', 'desktop.ini']) {
        await writeFile(join(repo.root, '.farna/personas', name), 'metadata', 'utf8');
        await writeFile(join(repo.root, '.farna/resources/rules', name), 'metadata', 'utf8');
        await writeFile(join(repo.root, '.farna/resources/permissions', name), 'metadata', 'utf8');
        await writeFile(join(repo.root, '.farna/resources', name), 'metadata', 'utf8');
      }
      const source = await loadSource(repo.root);
      expect(source.personas.map((persona) => persona.id)).not.toContain('.DS_Store');
      const result = await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      expect(result.personas).toEqual(['builder', 'builder-python', 'reviewer']);
    } finally {
      await repo.cleanup();
    }
  });

  it('compiles a clone where git dropped the empty source directories', async () => {
    const repo = await createEmptyTempDir();
    try {
      await runInit(repo.root);
      // Simulate `git clone`: git does not track an empty directory, so the
      // directories `init` created are absent until a file lands in them.
      await rm(join(repo.root, '.farna/personas'), { recursive: true, force: true });
      await rm(join(repo.root, '.farna/resources'), { recursive: true, force: true });

      const source = await loadSource(repo.root);
      expect(source.personas).toEqual([]);
      expect(source.rules).toEqual([]);
      expect(source.permissions).toEqual([]);

      const result = await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      expect(result.personas).toEqual([]);
      const check = await runCheck(repo.root, new FakeRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
