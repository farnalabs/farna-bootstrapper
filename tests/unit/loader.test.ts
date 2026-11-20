import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSource } from '../../src/compose/resolve.js';
import { loadConfig } from '../../src/config/load.js';
import { FarnaError } from '../../src/core/errors.js';
import { loadSource } from '../../src/source/load.js';
import { createTempRepo } from '../support/temp-repo.js';

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

  it('rejects an unsupported resource kind', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(
        join(repo.root, '.farna/personas/reviewer.yaml'),
        'kind: persona\nid: reviewer\ndisplayName: Reviewer\npurpose: Reviews a change.\nresources:\n  - permission/review-only\n',
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
      await mkdir(join(repo.root, '.farna/resources/permissions'), { recursive: true });
      const error = await expectFarnaError(loadSource(repo.root), 'F001_INVALID_CONFIG');
      expect(error.message).toContain('resource kind "permissions" is not implemented');
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
});
