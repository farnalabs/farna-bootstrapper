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

function map(tools: PermissionTools, patterns: PermissionPatterns = {}) {
  const { permissions, warnings } = resolve([{ id: 'builder-default', tools, patterns }]);
  const mapped = mapPermissions(permissions, { persona: 'builder', target: 'claudecode' });
  return { entries: mapped.entries, warnings: [...warnings, ...mapped.warnings] };
}

function codes(warnings: readonly Warning[]): string[] {
  return warnings.map((entry) => entry.code);
}

describe('permission mapping', () => {
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
      permissions: [
        {
          kind: 'permission',
          id: 'builder-default',
          tools: { read: 'allow', write: 'allow', edit: 'allow', shell: 'allow', task: 'deny' },
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
