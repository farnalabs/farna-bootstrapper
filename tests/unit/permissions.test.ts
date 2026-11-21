import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSource } from '../../src/compose/resolve.js';
import type { Config } from '../../src/config/schema.js';
import { FarnaError } from '../../src/core/errors.js';
import { personaSourceFile } from '../../src/materialise/source-tree.js';
import {
  emptyResolvedPermissions,
  mapPermissions,
  mergePermission,
  type PermissionContribution,
  type PermissionPatterns,
  type PermissionTools,
  type ResolvedPermissions,
} from '../../src/permissions/permissions.js';
import type { Warning } from '../../src/report/warnings.js';
import { loadSource, type SourceTree } from '../../src/source/load.js';
import { createTempRepo } from '../support/temp-repo.js';

const CONFIG: Config = {
  schemaVersion: 1,
  targets: { claudecode: {} },
  models: { standard: { claudecode: 'claude-sonnet-4-5' } },
};

function resolve(contributions: PermissionContribution[]): {
  permissions: ResolvedPermissions;
  warnings: Warning[];
} {
  const permissions = emptyResolvedPermissions();
  const warnings: Warning[] = [];
  for (const contribution of contributions) {
    mergePermission(permissions, contribution, {
      persona: 'builder',
      target: 'claudecode',
      warnings,
    });
  }
  return { permissions, warnings };
}

function map(tools: PermissionTools, patterns: PermissionPatterns = {}, allowlist = false) {
  const { permissions, warnings } = resolve([
    { id: 'builder-default', tools, patterns, allowlist },
  ]);
  const mapped = mapPermissions(permissions, { persona: 'builder', target: 'claudecode' });
  return {
    entries: mapped.entries,
    allowlist: mapped.allowlist,
    warnings: [...warnings, ...mapped.warnings],
  };
}

/** One persona whose only permission is the resource under test. */
function personaSource(
  tools: PermissionTools,
  patterns: PermissionPatterns,
  allowlist: boolean,
): string {
  const source: SourceTree = {
    personas: [
      {
        kind: 'persona',
        id: 'builder',
        displayName: 'Builder',
        purpose: 'Writes code.',
        resources: ['permission/builder-default'],
        path: '.farna/personas/builder.yaml',
      },
    ],
    rules: [],
    mcp: [],
    skills: [],
    commands: [],
    hooks: [],
    permissions: [
      {
        kind: 'permission',
        id: 'builder-default',
        tools,
        ...(Object.keys(patterns).length === 0 ? {} : { patterns }),
        allowlist,
        path: '.farna/resources/permissions/builder-default.jsonc',
      },
    ],
  };
  const persona = resolveSource(source, CONFIG).personas[0];
  if (persona === undefined) {
    throw new Error('the fixture produced no persona');
  }
  return personaSourceFile(persona);
}

function codes(warnings: readonly Warning[]): string[] {
  return warnings.map((entry) => entry.code);
}

describe('permission mapping', () => {
  it('defaults to a deny-list: a partial allow set emits no tools', () => {
    const { entries, allowlist } = map({ read: 'allow', shell: 'deny' });
    expect(entries.allow).toEqual(['Read']);
    expect(entries.deny).toEqual(['Bash']);
    expect(allowlist).toBe(false);
    const frontmatter = personaSource({ read: 'allow', shell: 'deny' }, {}, false);
    expect(frontmatter).not.toContain('tools:');
    expect(frontmatter).toContain('disallowedTools:');
  });

  it('emits tools and warns W113 only when a resource opts in', () => {
    const { allowlist, warnings } = map({ read: 'allow' }, {}, true);
    expect(allowlist).toBe(true);
    const narrowing = warnings.filter((entry) => entry.code === 'W113_ALLOW_LIST_NARROWS');
    expect(narrowing).toHaveLength(1);
    expect(narrowing[0]?.message).toContain('Glob');
    expect(narrowing[0]?.message).toContain('Read');

    const frontmatter = personaSource({ read: 'allow' }, {}, true);
    expect(frontmatter).toContain('tools:');
    expect(frontmatter).toContain('- Read');
  });

  it('reports an explicit allow-list that resolved to no allow entry, and emits no tools', () => {
    // Every category is deny: the opt-in has nothing to list. Emitting
    // `tools: []` would remove every tool, so the field is omitted and the
    // no-effect case is reported rather than silently dropped.
    const { entries, allowlist, warnings } = map({ read: 'deny' }, {}, true);
    expect(entries.allow).toEqual([]);
    expect(allowlist).toBe(false);
    const narrowing = warnings.filter((entry) => entry.code === 'W113_ALLOW_LIST_NARROWS');
    expect(narrowing).toHaveLength(1);
    expect(narrowing[0]?.message).toContain('has no effect');
    expect(narrowing[0]?.message).toContain('read');

    const frontmatter = personaSource({ read: 'deny' }, {}, true);
    expect(frontmatter).not.toContain('tools:');
    expect(frontmatter).toContain('disallowedTools:');
  });

  it('reports a deny that removed every allow entry from an opted-in list', () => {
    // One resource opts in with `read: allow`; a second denies read. Deny wins,
    // the allow set is empty, and the opt-in must not silently become a
    // no-effect flag the digest still records.
    const { warnings } = resolve([
      { id: 'allow-list', tools: { read: 'allow' }, patterns: {}, allowlist: true },
      { id: 'deny-read', tools: { read: 'deny' }, patterns: {}, allowlist: false },
    ]);
    const mapped = mapPermissions(
      resolve([
        { id: 'allow-list', tools: { read: 'allow' }, patterns: {}, allowlist: true },
        { id: 'deny-read', tools: { read: 'deny' }, patterns: {}, allowlist: false },
      ]).permissions,
      { persona: 'builder', target: 'claudecode' },
    );
    expect(mapped.allowlist).toBe(false);
    const all = [...warnings, ...mapped.warnings];
    expect(codes(all)).toContain('W106_DENY_WINS');
    const narrowing = all.filter((entry) => entry.code === 'W113_ALLOW_LIST_NARROWS');
    expect(narrowing).toHaveLength(1);
    expect(narrowing[0]?.message).toContain('removed by read (deny by permission/deny-read)');
  });

  it('records the effective allow-list in the digest, so a no-effect opt-in changes nothing', () => {
    const source = (allowlist: boolean): SourceTree => ({
      personas: [
        {
          kind: 'persona',
          id: 'builder',
          displayName: 'Builder',
          purpose: 'Writes code.',
          resources: ['permission/locked'],
          path: '.farna/personas/builder.yaml',
        },
      ],
      rules: [],
      mcp: [],
      skills: [],
      commands: [],
      hooks: [],
      permissions: [
        {
          kind: 'permission',
          id: 'locked',
          tools: { read: 'deny' },
          allowlist,
          path: '.farna/resources/permissions/locked.jsonc',
        },
      ],
    });
    const opted = resolveSource(source(true), CONFIG).personas[0];
    const plain = resolveSource(source(false), CONFIG).personas[0];
    expect(opted).toBeDefined();
    expect(plain).toBeDefined();
    if (opted === undefined || plain === undefined) {
      return;
    }
    // The opt-in has no effect on the emitted form, so it must not change the
    // digest either: the digest is derived from the value that decides emission.
    expect(opted.claude.allowlist).toBe(false);
    expect(opted.permissionDigest).toBe(plain.permissionDigest);
    expect(personaSourceFile(opted)).toBe(personaSourceFile(plain));
  });

  it('treats two symmetric declarations differently, not as one allow-list', () => {
    // The same declaration, once implicit (deny-list) and once explicit
    // (allow-list). The lens report's failure was that the first silently
    // became the second.
    const implicit = personaSource({ read: 'allow' }, {}, false);
    const explicit = personaSource({ read: 'allow' }, {}, true);
    expect(implicit).not.toContain('tools:');
    expect(explicit).toContain('tools:');
  });

  it('emits the exact Claude Code byte form for a catch-all', () => {
    const { entries } = map({
      read: 'allow',
      write: 'allow',
      edit: 'allow',
      shell: 'allow',
      task: 'deny',
    });
    expect(entries.allow).toEqual(['Bash', 'Edit', 'Read', 'Write']);
    expect(entries.deny).toEqual(['Agent']);
    for (const entry of [...entries.allow, ...entries.deny]) {
      expect(entry).toMatch(/^[A-Z][A-Za-z]*$/);
    }
  });

  it('maps write onto Write and produces no warning', () => {
    const { entries, warnings } = map({ write: 'allow' });
    expect(entries.allow).toEqual(['Write']);
    expect(entries.deny).toEqual([]);
    expect(codes(warnings)).not.toContain('W112_PERMISSION_LOSSY');
    expect(warnings).toEqual([]);
  });

  it('maps task onto Agent', () => {
    const { entries } = map({ task: 'allow' });
    expect(entries.allow).toEqual(['Agent']);
    expect(entries.deny).toEqual([]);
  });

  it('emits ask as deny and warns W111', () => {
    const { entries, warnings } = map({ shell: 'ask' });
    expect(entries.deny).toEqual(['Bash']);
    expect(entries.allow).toEqual([]);
    const downgraded = warnings.filter((entry) => entry.code === 'W111_ASK_DOWNGRADED');
    expect(downgraded).toHaveLength(1);
    expect(downgraded[0]?.severity).toBe('medium');
    expect(downgraded[0]?.message).toContain('shell');
  });

  it('emits patterns as Tool(P) with the pattern verbatim', () => {
    const { entries } = map(
      { shell: 'allow', edit: 'deny' },
      { shell: { 'pytest *': 'allow' }, edit: { 'src/**': 'deny' } },
    );
    expect(entries.allow).toEqual(['Bash', 'Bash(pytest *)']);
    expect(entries.deny).toEqual(['Edit', 'Edit(src/**)']);
  });

  it('keeps write and edit as separate tools with no deny-wins report', () => {
    const { entries, warnings } = map({ write: 'allow', edit: 'deny' });
    expect(entries.allow).toEqual(['Write']);
    expect(entries.deny).toEqual(['Edit']);
    expect(codes(warnings)).not.toContain('W106_DENY_WINS');
  });

  it('does not emit an allow pattern under a category that resolves deny', () => {
    const { entries, warnings } = map({ shell: 'deny' }, { shell: { 'pytest *': 'allow' } });
    expect(entries.allow).toEqual([]);
    expect(entries.deny).toEqual(['Bash']);
    const denyWins = warnings.filter((entry) => entry.code === 'W106_DENY_WINS');
    expect(denyWins).toHaveLength(1);
    expect(denyWins[0]?.message).toContain('pytest *');
  });

  it('drops an allow pattern when the category ask is downgraded to deny', () => {
    const { entries, warnings } = map({ write: 'ask' }, { write: { 'src/**': 'allow' } });
    expect(entries.allow).toEqual([]);
    expect(entries.deny).toEqual(['Write']);
    expect(warnings.filter((entry) => entry.code === 'W111_ASK_DOWNGRADED')).toHaveLength(1);
    const denyWins = warnings.filter((entry) => entry.code === 'W106_DENY_WINS');
    expect(denyWins).toHaveLength(1);
    expect(denyWins[0]?.message).toContain('src/**');
  });

  it('keeps a deny pattern under an allow category, which is not self-contradictory', () => {
    const { entries } = map({ edit: 'allow' }, { edit: { 'src/**': 'deny' } });
    expect(entries.allow).toEqual(['Edit']);
    expect(entries.deny).toEqual(['Edit(src/**)']);
  });

  it('refuses network with F011, naming the category and the target', () => {
    try {
      map({ network: 'allow' });
      throw new Error('expected F011');
    } catch (error) {
      expect(error).toBeInstanceOf(FarnaError);
      const farna = error as FarnaError;
      expect(farna.code).toBe('F011_PERMISSION_UNMAPPED');
      expect(farna.exitCode).toBe(3);
      expect(farna.message).toContain('network');
      expect(farna.subject).toContain('claudecode');
      expect(farna.subject).toContain('network');
    }
  });

  it('refuses a bare mcp category with F011', () => {
    try {
      map({ mcp: 'deny' });
      throw new Error('expected F011');
    } catch (error) {
      expect(error).toBeInstanceOf(FarnaError);
      expect((error as FarnaError).code).toBe('F011_PERMISSION_UNMAPPED');
      expect((error as FarnaError).message).toContain('mcp');
    }
  });

  it('refuses a wildcard because it expands to network', () => {
    try {
      map({ '*': 'allow' });
      throw new Error('expected F011');
    } catch (error) {
      expect(error).toBeInstanceOf(FarnaError);
      expect((error as FarnaError).code).toBe('F011_PERMISSION_UNMAPPED');
      expect((error as FarnaError).message).toContain('network');
    }
  });
});

describe('permission pattern grammar', () => {
  for (const [label, pattern] of [
    ['a closing parenthesis', 'rm -rf)'],
    ['a comma', 'a,b'],
    ['a newline', `line${String.fromCharCode(10)}break`],
    ['a control character', `a${String.fromCharCode(0)}b`],
    ['leading whitespace', ' rm *'],
    ['trailing whitespace', 'rm * '],
  ] as const) {
    it(`refuses ${label} in a pattern with F001 and a grammar message`, async () => {
      const repo = await createTempRepo('composed');
      try {
        await writeFile(
          join(repo.root, '.farna/resources/permissions/bad.jsonc'),
          `${JSON.stringify(
            {
              kind: 'permission',
              id: 'bad',
              tools: { shell: 'allow' },
              patterns: { shell: { [pattern]: 'allow' } },
            },
            null,
            2,
          )}\n`,
          'utf8',
        );
        await expect(loadSource(repo.root)).rejects.toMatchObject({
          code: 'F001_INVALID_CONFIG',
          subject: '.farna/resources/permissions/bad.jsonc',
        });
        await expect(loadSource(repo.root)).rejects.toThrow(/not representable|whitespace|control/);
      } finally {
        await repo.cleanup();
      }
    });
  }
});

describe('permission source validation', () => {
  it('rejects a category outside the canonical vocabulary with F001', async () => {
    const repo = await createTempRepo('composed');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/permissions/bad.jsonc'),
        `${JSON.stringify(
          { kind: 'permission', id: 'bad', tools: { readonly: 'allow' } },
          null,
          2,
        )}\n`,
        'utf8',
      );
      try {
        await loadSource(repo.root);
        throw new Error('expected F001');
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        expect((error as FarnaError).code).toBe('F001_INVALID_CONFIG');
        expect((error as FarnaError).message).toContain('readonly');
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a wildcard combined with a specific category with F001', async () => {
    const repo = await createTempRepo('composed');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/permissions/bad.jsonc'),
        `${JSON.stringify(
          { kind: 'permission', id: 'bad', tools: { '*': 'allow', read: 'deny' } },
          null,
          2,
        )}\n`,
        'utf8',
      );
      try {
        await loadSource(repo.root);
        throw new Error('expected F001');
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        expect((error as FarnaError).code).toBe('F001_INVALID_CONFIG');
        expect((error as FarnaError).message).toContain('cannot be combined');
      }
    } finally {
      await repo.cleanup();
    }
  });
});

describe('permission source form', () => {
  it('never writes a product category into the renderer source tree', () => {
    const source: SourceTree = {
      personas: [
        {
          kind: 'persona',
          id: 'builder',
          displayName: 'Builder',
          purpose: 'Writes code.',
          resources: ['rule/house-style', 'permission/builder-default'],
          path: '.farna/personas/builder.yaml',
        },
      ],
      rules: [
        {
          kind: 'rule',
          id: 'house-style',
          displayName: 'House style',
          body: 'FBS_RULE_BUILDER_4a1c\n',
          path: '.farna/resources/rules/house-style.md',
        },
      ],
      mcp: [],
      skills: [],
      commands: [],
      hooks: [],
      permissions: [
        {
          kind: 'permission',
          id: 'builder-default',
          tools: { read: 'allow', write: 'allow', edit: 'allow', shell: 'allow', task: 'deny' },
          allowlist: true,
          path: '.farna/resources/permissions/builder-default.jsonc',
        },
      ],
    };

    const resolved = resolveSource(source, CONFIG);
    const persona = resolved.personas[0];
    expect(persona).toBeDefined();
    if (persona === undefined) {
      return;
    }

    const file = personaSourceFile(persona);
    const frontmatter = file.slice(0, file.indexOf('\n---\n', 4));
    expect(frontmatter).toContain('- Bash');
    expect(frontmatter).toContain('- Edit');
    expect(frontmatter).toContain('- Read');
    expect(frontmatter).toContain('- Agent');
    expect(frontmatter).toContain('- Write');
    expect(frontmatter).not.toMatch(/\b(shell|network|task|write)\b/);
  });
});
