import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { resolveSource } from '../../src/compose/resolve.js';
import { loadConfig } from '../../src/config/load.js';
import { FarnaError } from '../../src/core/errors.js';
import { loadSource } from '../../src/source/load.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createTempRepo, hashTree, readText } from '../support/temp-repo.js';

async function resolvedPersonas(root: string) {
  const config = await loadConfig(root);
  return resolveSource(await loadSource(root), config);
}

async function failure(promise: Promise<unknown>): Promise<FarnaError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FarnaError);
    return error as FarnaError;
  }
  throw new Error('expected a FarnaError, but nothing was thrown');
}

describe('persona composition', () => {
  it('unions the base rules and permissions into the composed persona', async () => {
    const repo = await createTempRepo('composed');
    try {
      const source = await resolvedPersonas(repo.root);
      const python = source.personas.find((persona) => persona.id === 'builder-python');
      expect(python).toBeDefined();
      if (python === undefined) {
        return;
      }

      expect(python.extends).toBe('builder');
      expect(python.chain).toEqual(['builder', 'builder-python']);
      expect(python.model).toBe('claude-sonnet-4-5');
      expect(python.rules.map((rule) => rule.id)).toEqual(['house-style', 'python-style']);
      expect(python.resources.map((resource) => `${resource.kind}/${resource.id}`)).toEqual([
        'rule/house-style',
        'rule/python-style',
        'permission/builder-default',
        'permission/python-tools',
      ]);
      expect(python.resources.map((resource) => resource.fromPersona)).toEqual([
        'builder',
        'builder-python',
        'builder',
        'builder-python',
      ]);

      // The permission union: base allow/deny plus the child's extra resources.
      expect(python.permissions.values['task']).toEqual({
        value: 'deny',
        source: 'builder-default',
      });
      expect(python.claude).toEqual({
        allow: ['Bash', 'Bash(pytest *)', 'Edit', 'Read'],
        deny: ['Task'],
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('writes the composed body with both markers and no reviewer content', async () => {
    const repo = await createTempRepo('composed');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const body = await readText(repo.root, '.claude/agents/builder-python.md');

      expect(body).toContain('FBS_RULE_BUILDER_4a1c');
      expect(body).toContain('FBS_RULE_PYTHON_5e3b');
      expect(body).not.toContain('FBS_RULE_REVIEWER_8d2f');
      expect(body).toContain('## House style');
      expect(body).toContain('## Python style');
      expect(body).toContain('  - Bash\n');
    } finally {
      await repo.cleanup();
    }
  });

  it('records the composed persona, resolved resource ids and permission digest in the lockfile', async () => {
    const repo = await createTempRepo('composed');
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const lock = JSON.parse(await readText(repo.root, '.farna/lock.json')) as {
        schemaVersion: number;
        personas: Array<{
          id: string;
          extends?: string;
          permissionDigest: string;
          resources: Array<{ kind: string; id: string; fromPersona: string }>;
        }>;
      };
      expect(lock.schemaVersion).toBe(1);
      const python = lock.personas.find((persona) => persona.id === 'builder-python');
      expect(python?.extends).toBe('builder');
      expect(python?.permissionDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(python?.resources.map((resource) => `${resource.kind}/${resource.id}`)).toEqual([
        'rule/house-style',
        'rule/python-style',
        'permission/builder-default',
        'permission/python-tools',
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a network permission at plan time with F011 and writes nothing', async () => {
    const repo = await createTempRepo('composed');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/permissions/python-tools.jsonc'),
        `${JSON.stringify(
          { kind: 'permission', id: 'python-tools', tools: { network: 'deny' } },
          null,
          2,
        )}\n`,
        'utf8',
      );
      const before = await hashTree(repo.root);
      const error = await failure(
        runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget()),
      );
      expect(error.code).toBe('F011_PERMISSION_UNMAPPED');
      expect(error.exitCode).toBe(3);
      expect(error.message).toContain('network');
      expect(error.subject).toContain('claudecode');
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('emits ask as deny through composition and warns W111', async () => {
    const repo = await createTempRepo('composed');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/permissions/python-tools.jsonc'),
        `${JSON.stringify(
          {
            kind: 'permission',
            id: 'python-tools',
            tools: { read: 'allow', shell: 'ask' },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      const source = await resolvedPersonas(repo.root);
      const python = source.personas.find((persona) => persona.id === 'builder-python');
      expect(python?.claude.deny).toContain('Bash');
      expect(python?.claude.allow).not.toContain('Bash');
      const downgraded = python?.warnings.filter((entry) => entry.code === 'W111_ASK_DOWNGRADED');
      expect(downgraded).toHaveLength(1);
      expect(downgraded?.[0]?.message).toContain('shell');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses two different models with F005', async () => {
    const repo = await createTempRepo('composed');
    try {
      await writeFile(
        join(repo.root, '.farna/personas/builder-python.yaml'),
        [
          'kind: persona',
          'id: builder-python',
          'displayName: Python Builder',
          'purpose: Writes Python and runs the Python checks.',
          'extends: builder',
          'model: fast',
          'resources:',
          '  - rule/python-style',
          '',
        ].join('\n'),
        'utf8',
      );
      const error = await failure(resolvedPersonas(repo.root));
      expect(error.code).toBe('F005_CONFLICT');
      expect(error.message).toContain('two different models');
      expect(error.message).toContain('standard');
      expect(error.message).toContain('fast');
    } finally {
      await repo.cleanup();
    }
  });

  it('lets deny win across the composition and reports W106', async () => {
    const repo = await createTempRepo('composed');
    try {
      const source = await resolvedPersonas(repo.root);
      const python = source.personas.find((persona) => persona.id === 'builder-python');
      const denyWins = python?.warnings.filter((entry) => entry.code === 'W106_DENY_WINS') ?? [];
      expect(denyWins).toHaveLength(1);
      expect(denyWins[0]?.severity).toBe('medium');
      expect(denyWins[0]?.message).toContain('builder-default');
      expect(denyWins[0]?.message).toContain('python-tools');
      expect(python?.claude.deny).toContain('Task');
      expect(python?.claude.allow).not.toContain('Task');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a duplicate permission id with different content with F005', async () => {
    const repo = await createTempRepo('composed');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/permissions/duplicate.jsonc'),
        `${JSON.stringify(
          {
            kind: 'permission',
            id: 'builder-default',
            tools: { read: 'deny' },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      const error = await failure(loadSource(repo.root));
      expect(error.code).toBe('F005_CONFLICT');
      expect(error.message).toContain('different content');
      expect(error.subject).toBe('.farna/resources/permissions/duplicate.jsonc');
    } finally {
      await repo.cleanup();
    }
  });

  it('deduplicates a duplicate permission id with identical content', async () => {
    const repo = await createTempRepo('composed');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/permissions/copy.jsonc'),
        `${JSON.stringify(
          {
            kind: 'permission',
            id: 'builder-default',
            tools: {
              read: 'allow',
              write: 'allow',
              edit: 'allow',
              shell: 'allow',
              task: 'deny',
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      const source = await loadSource(repo.root);
      expect(source.permissions.map((permission) => permission.id)).toEqual([
        'builder-default',
        'python-tools',
        'review-only',
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses an extends cycle with F001 and names the path', async () => {
    const repo = await createTempRepo('composed');
    try {
      await writeFile(
        join(repo.root, '.farna/personas/builder.yaml'),
        [
          'kind: persona',
          'id: builder',
          'displayName: Builder',
          'purpose: Writes code, runs the tests, and follows the house conventions.',
          'extends: builder-python',
          'resources:',
          '  - rule/house-style',
          '  - permission/builder-default',
          '',
        ].join('\n'),
        'utf8',
      );
      const error = await failure(resolvedPersonas(repo.root));
      expect(error.code).toBe('F001_INVALID_CONFIG');
      expect(error.message).toContain('extends cycle: builder -> builder-python -> builder');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses an extends that names no persona', async () => {
    const repo = await createTempRepo('composed');
    try {
      await writeFile(
        join(repo.root, '.farna/personas/builder-python.yaml'),
        [
          'kind: persona',
          'id: builder-python',
          'displayName: Python Builder',
          'purpose: Writes Python and runs the Python checks.',
          'extends: ghost',
          'resources:',
          '  - rule/python-style',
          '',
        ].join('\n'),
        'utf8',
      );
      const error = await failure(resolvedPersonas(repo.root));
      expect(error.code).toBe('F001_INVALID_CONFIG');
      expect(error.message).toContain('names no persona');
    } finally {
      await repo.cleanup();
    }
  });
});
