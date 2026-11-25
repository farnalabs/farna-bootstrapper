import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGenerate } from '../../src/cli/commands/generate.js';
import {
  assertNoLocationCollisions,
  findLocationCollisions,
  managedLocationsOf,
} from '../../src/config/collision.js';
import { loadConfig } from '../../src/config/load.js';
import { type Config, configSchema } from '../../src/config/schema.js';
import { FarnaError } from '../../src/core/errors.js';
import type { RenderTarget } from '../../src/render/port.js';
import { createTempRepo, hashTree } from '../support/temp-repo.js';

/** A config shaped exactly as the schema produces one. */
function configOf(targets: Record<string, Record<string, never>>): Config {
  return { schemaVersion: 1, targets } as Config;
}

describe('location-collision guard', () => {
  it('refuses two targets that claim one directory', () => {
    const collisions = findLocationCollisions({
      alpha: ['.shared/agents'],
      beta: ['.shared/agents'],
    });
    expect(collisions).toEqual([{ location: '.shared/agents', targets: ['alpha', 'beta'] }]);
  });

  it('accepts two targets whose locations are disjoint', () => {
    expect(
      findLocationCollisions({
        alpha: ['.alpha/agents'],
        beta: ['.beta/agents', 'beta.jsonc'],
      }),
    ).toEqual([]);
  });

  it('is not a hard-coded target pair: any two ids that share a location collide', () => {
    // The synthetic ids cannot be named anywhere in the guard, so a collision
    // here proves the rule is structural rather than an OpenCode special case.
    const collisions = findLocationCollisions({
      alpha: ['.claude/agents', '.alpha/state'],
      beta: ['.beta/state', '.claude/agents'],
      gamma: ['.gamma/agents'],
    });
    expect(collisions).toEqual([{ location: '.claude/agents', targets: ['alpha', 'beta'] }]);
  });

  it('names every shared location and both claimants in location order', () => {
    const collisions = findLocationCollisions({
      opencode: managedLocationsOf('opencode'),
      opencodev1: managedLocationsOf('opencodev1'),
    });
    expect(collisions.map((collision) => collision.location)).toEqual([
      '.opencode/agents',
      '.opencode/commands',
      '.opencode/plugins',
      '.opencode/skills',
      'opencode.jsonc',
    ]);
    for (const collision of collisions) {
      expect(collision.targets).toEqual(['opencode', 'opencodev1']);
    }
  });

  it('claims the three Claude Code workspace files as well as the agent directory', () => {
    expect(managedLocationsOf('claudecode')).toEqual([
      '.claude/agents',
      '.mcp.json',
      '.claude/settings.json',
      'CLAUDE.md',
    ]);
  });

  it('refuses a synthetic target that claims a Claude Code workspace file', () => {
    expect(
      findLocationCollisions({
        claudecode: managedLocationsOf('claudecode'),
        alpha: ['.mcp.json'],
      }),
    ).toEqual([{ location: '.mcp.json', targets: ['alpha', 'claudecode'] }]);
  });

  it('accepts the real claudecode and opencode location sets', () => {
    expect(
      findLocationCollisions({
        claudecode: managedLocationsOf('claudecode'),
        opencode: managedLocationsOf('opencode'),
      }),
    ).toEqual([]);
  });

  it('raises F005_CONFLICT with exit 2 and names the shared locations', () => {
    const config = configOf({ opencode: {}, opencodev1: {} });
    let failure: FarnaError | undefined;
    try {
      assertNoLocationCollisions(config);
    } catch (error) {
      expect(error).toBeInstanceOf(FarnaError);
      failure = error as FarnaError;
    }
    expect(failure?.code).toBe('F005_CONFLICT');
    expect(failure?.exitCode).toBe(2);
    expect(failure?.subject).toBe('.farna/config.jsonc');
    expect(failure?.message).toContain('.opencode/agents (opencode, opencodev1)');
    expect(failure?.message).toContain('opencode.jsonc (opencode, opencodev1)');
    expect(failure?.action).toContain('two targets cannot own one location');
  });

  it('returns without raising for a config whose targets do not collide', () => {
    expect(() =>
      assertNoLocationCollisions(configOf({ claudecode: {}, opencode: {} })),
    ).not.toThrow();
  });
});

/** Rewrite the committed config of a fixture repository. */
async function setConfig(root: string, text: string): Promise<void> {
  await writeFile(join(root, '.farna/config.jsonc'), text, 'utf8');
}

const TWO_OPENCODE_CONFIG = [
  '{',
  '  "schemaVersion": 1,',
  '  "targets": { "opencode": {}, "opencodev1": {} }',
  '}',
  '',
].join('\n');

const TWO_FAMILIES_CONFIG = [
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

describe('loaded config and the location rule', () => {
  it('accepts claudecode plus one OpenCode target', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await setConfig(repo.root, TWO_FAMILIES_CONFIG);
      const config = await loadConfig(repo.root);
      expect(Object.keys(config.targets).sort()).toEqual(['claudecode', 'opencode']);
    } finally {
      await repo.cleanup();
    }
  });

  it('the schema alone accepts two OpenCode targets, so the refusal is the guard', () => {
    expect(
      configSchema.safeParse({ schemaVersion: 1, targets: { opencode: {}, opencodev1: {} } })
        .success,
    ).toBe(true);
  });

  it('refuses two OpenCode targets as F005_CONFLICT with exit 2', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await setConfig(repo.root, TWO_OPENCODE_CONFIG);
      let failure: FarnaError | undefined;
      try {
        await loadConfig(repo.root);
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F005_CONFLICT');
      expect(failure?.exitCode).toBe(2);
      expect(failure?.message).toContain('.opencode/agents (opencode, opencodev1)');
    } finally {
      await repo.cleanup();
    }
  });

  it('still refuses an unsupported target with F001, unchanged', async () => {
    const repo = await createTempRepo('demo');
    try {
      await setConfig(repo.root, '{"schemaVersion":1,"targets":{"cursor":{}}}\n');
      await expect(loadConfig(repo.root)).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        exitCode: 1,
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a collision before a renderer is called and writes nothing', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await setConfig(repo.root, TWO_OPENCODE_CONFIG);
      const before = await hashTree(repo.root);
      const exploding: RenderTarget = {
        identity() {
          throw new Error('renderer identity must not be read for a refused config');
        },
        async generate() {
          throw new Error('renderer must not be called for a refused config');
        },
      };
      await expect(runGenerate({ cwd: repo.root, dryRun: false }, exploding)).rejects.toMatchObject(
        { code: 'F005_CONFLICT', exitCode: 2 },
      );
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });
});
