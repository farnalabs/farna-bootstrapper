import { describe, expect, it } from 'vitest';
import {
  MANAGED_OUTPUT_DIRS,
  MANAGED_OUTPUT_FILES,
  PROFILE_TARGETS,
  REGION_OUTPUTS,
  SUPPORTED_TARGETS,
  type SupportedTarget,
  TARGET_FACTS,
} from '../../src/core/constants.js';

type Facts = {
  profile: boolean;
  dirs: readonly string[];
  files: readonly string[];
  regions: Readonly<Record<string, string>>;
};

/**
 * The values each derived constant carried before `TARGET_FACTS` existed,
 * written out explicitly. The table is now the source of truth, so a wrong
 * derivation is invisible to every consumer; this is the copy that notices.
 */
const EXPECTED: Readonly<Record<SupportedTarget, Facts>> = {
  claudecode: {
    profile: true,
    dirs: ['.claude/agents'],
    files: ['.mcp.json', '.claude/settings.json', 'CLAUDE.md'],
    regions: { 'CLAUDE.md': 'claude-instructions' },
  },
  opencode: {
    profile: true,
    dirs: ['.opencode/agents', '.opencode/commands', '.opencode/skills', '.opencode/plugins'],
    files: ['opencode.jsonc'],
    regions: {},
  },
  opencodev1: {
    profile: true,
    dirs: ['.opencode/agents', '.opencode/commands', '.opencode/skills', '.opencode/plugins'],
    files: ['opencode.jsonc'],
    regions: {},
  },
};

describe('the per-target facts table', () => {
  it('declares exactly one entry for every supported target and no extra key', () => {
    expect(Object.keys(TARGET_FACTS).sort()).toEqual([...SUPPORTED_TARGETS].sort());
    for (const target of SUPPORTED_TARGETS) {
      expect(TARGET_FACTS[target]).toBeDefined();
    }
  });

  it('holds the values the derived constants carried before the table existed', () => {
    for (const target of SUPPORTED_TARGETS) {
      expect(TARGET_FACTS[target]).toEqual(EXPECTED[target]);
      expect(MANAGED_OUTPUT_DIRS[target]).toEqual(EXPECTED[target].dirs);
      expect(MANAGED_OUTPUT_FILES[target]).toEqual(EXPECTED[target].files);
    }
    expect(REGION_OUTPUTS).toEqual({ 'CLAUDE.md': 'claude-instructions' });
  });

  it('claims every region path in its target files, and claims no region path twice', () => {
    const owners = new Map<string, SupportedTarget>();
    for (const target of SUPPORTED_TARGETS) {
      for (const [path, regionId] of Object.entries(TARGET_FACTS[target].regions)) {
        expect(
          TARGET_FACTS[target].files,
          `${target} owns a region of an unclaimed path`,
        ).toContain(path);
        expect(regionId.length).toBeGreaterThan(0);
        expect(owners.has(path), `${path} is a region of more than one target`).toBe(false);
        owners.set(path, target);
      }
    }
    expect([...owners.keys()].sort()).toEqual(Object.keys(REGION_OUTPUTS).sort());
  });

  it('derives the profile targets from the profile flag, in sorted order', () => {
    const expected = SUPPORTED_TARGETS.filter((target) => TARGET_FACTS[target].profile).sort();
    expect([...PROFILE_TARGETS]).toEqual(expected);
  });

  it('shares no managed directory between targets, except the OpenCode pair exactly', () => {
    const documentedPair: readonly SupportedTarget[] = ['opencode', 'opencodev1'];
    for (let index = 0; index < SUPPORTED_TARGETS.length; index += 1) {
      for (let other = index + 1; other < SUPPORTED_TARGETS.length; other += 1) {
        const target = SUPPORTED_TARGETS[index];
        const neighbour = SUPPORTED_TARGETS[other];
        if (target === undefined || neighbour === undefined) {
          throw new Error('expected two supported targets');
        }
        const shared = TARGET_FACTS[target].dirs.filter((dir) =>
          TARGET_FACTS[neighbour].dirs.includes(dir),
        );
        const documented = documentedPair.includes(target) && documentedPair.includes(neighbour);
        if (documented) {
          expect(shared).toHaveLength(TARGET_FACTS[target].dirs.length);
          expect([...shared].sort()).toEqual([...TARGET_FACTS[target].dirs].sort());
          expect([...shared].sort()).toEqual([...TARGET_FACTS[neighbour].dirs].sort());
        } else {
          expect(shared, `${target} and ${neighbour} share ${shared.join(', ')}`).toHaveLength(0);
        }
      }
    }
  });
});
