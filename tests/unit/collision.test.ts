import { describe, expect, it } from 'vitest';
import {
  assertNoLocationCollisions,
  findLocationCollisions,
  managedLocationsOf,
} from '../../src/config/collision.js';
import type { Config } from '../../src/config/schema.js';
import { FarnaError } from '../../src/core/errors.js';

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
