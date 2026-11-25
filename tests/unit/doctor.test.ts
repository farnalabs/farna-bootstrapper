import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/cli/commands/doctor.js';
import { FarnaError } from '../../src/core/errors.js';
import { formatDoctor } from '../../src/report/format.js';
import {
  createEmptyTempDir,
  createTempRepo,
  hashTree,
  type TempRepo,
} from '../support/temp-repo.js';

const skipSymlinks = process.platform === 'win32';

async function editConfig(repo: TempRepo, replace: (text: string) => string): Promise<void> {
  const path = join(repo.root, '.farna/config.jsonc');
  await writeFile(path, replace(await readFile(path, 'utf8')), 'utf8');
}

async function expectRefusal(repo: TempRepo): Promise<FarnaError> {
  const before = await hashTree(repo.root);
  try {
    await runDoctor(repo.root);
  } catch (error) {
    expect(error).toBeInstanceOf(FarnaError);
    expect(await hashTree(repo.root)).toBe(before);
    return error as FarnaError;
  }
  throw new Error('expected doctor to refuse the source, but it reported ok');
}

describe('doctor', () => {
  it('validates the demo source without writing and reports every persona', async () => {
    const repo = await createTempRepo('demo');
    try {
      const before = await hashTree(repo.root);
      const result = await runDoctor(repo.root);

      expect(await hashTree(repo.root)).toBe(before);
      expect(result).toMatchObject({
        ok: true,
        configPath: '.farna/config.jsonc',
        targets: [
          {
            target: 'claudecode',
            mode: 'agent',
            activePersona: null,
            counts: { personas: 2, live: 2, modelClasses: 1 },
          },
        ],
      });
      const target = result.targets[0];
      expect(target?.personas.map((persona) => persona.id)).toEqual(['builder', 'reviewer']);
      expect(target?.checks.map((check) => check.name)).toEqual([
        'config schema',
        'source tree and paths',
        'personas and extends chains',
        'resource references',
        'model map',
        'target and profile mode',
        'permission categories and patterns',
        'secret references',
      ]);
      expect(target?.notLive).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('attributes a composed resource to its base persona and rank', async () => {
    const repo = await createTempRepo('composed');
    try {
      const result = await runDoctor(repo.root);
      const builderPython = result.targets[0]?.personas.find(
        (persona) => persona.id === 'builder-python',
      );
      expect(builderPython?.chain).toEqual(['builder', 'builder-python']);

      const inherited = builderPython?.resources.find(
        (resource) => resource.kind === 'rule' && resource.id === 'house-style',
      );
      expect(inherited).toMatchObject({
        fromPersona: 'builder',
        rank: 1,
        path: '.farna/resources/rules/house-style.md',
      });

      const own = builderPython?.resources.find(
        (resource) => resource.kind === 'rule' && resource.id === 'python-style',
      );
      expect(own).toMatchObject({ fromPersona: 'builder-python', rank: 0 });
    } finally {
      await repo.cleanup();
    }
  });

  it('reports profile mode with one live persona and the not-live remainder', async () => {
    const repo = await createTempRepo('profile');
    try {
      const result = await runDoctor(repo.root);
      const target = result.targets[0];
      expect(target?.mode).toBe('profile');
      expect(target?.activePersona).toBe('builder');
      expect(target?.personas.map((persona) => persona.id)).toEqual(['builder']);
      expect(target?.notLive).toEqual(['reviewer']);
      expect(target?.counts.personas).toBe(2);
      expect(target?.counts.live).toBe(1);
      // The live persona's workspace kinds are reported, because profile mode emits them.
      expect(target?.personas[0]?.resources.map((resource) => resource.kind)).toEqual([
        'rule',
        'permission',
        'mcp',
        'skill',
        'command',
        'hook',
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('renders a human report that names the target, mode and each resolved resource', async () => {
    const repo = await createTempRepo('composed');
    try {
      const text = formatDoctor(await runDoctor(repo.root));
      expect(text).toContain('farna-bootstrapper doctor');
      expect(text).toContain('claudecode (agent mode)');
      expect(text).toContain('personas  3 in source, 3 live');
      expect(text).toContain('rule/house-style');
      expect(text).toContain('(from builder, rank 1)');
      expect(text).toContain('doctor: ok');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses an extends cycle with F001 and writes nothing', async () => {
    const repo = await createTempRepo('composed');
    try {
      const path = join(repo.root, '.farna/personas/builder.yaml');
      await writeFile(
        path,
        (await readFile(path, 'utf8')).replace(
          'id: builder\n',
          'id: builder\nextends: builder-python\n',
        ),
        'utf8',
      );
      const error = await expectRefusal(repo);
      expect(error.code).toBe('F001_INVALID_CONFIG');
      expect(error.message).toContain('extends cycle');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a resource reference that names no resource', async () => {
    const repo = await createTempRepo('demo');
    try {
      const path = join(repo.root, '.farna/personas/reviewer.yaml');
      await writeFile(
        path,
        (await readFile(path, 'utf8')).replace(
          '  - rule/review-checklist\n',
          '  - rule/review-checklist\n  - rule/missing\n',
        ),
        'utf8',
      );
      const error = await expectRefusal(repo);
      expect(error.code).toBe('F001_INVALID_CONFIG');
      expect(error.message).toContain('unknown rule "missing"');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a model class with no mapping for the configured target', async () => {
    const repo = await createTempRepo('demo');
    try {
      await editConfig(
        repo,
        () =>
          `{
  "schemaVersion": 1,
  "targets": { "claudecode": {} },
  "models": { "standard": {} }
}
`,
      );
      const error = await expectRefusal(repo);
      expect(error.code).toBe('F001_INVALID_CONFIG');
      expect(error.message).toContain('has no "claudecode" mapping');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a config that does not validate, before any persona is resolved', async () => {
    const repo = await createTempRepo('demo');
    try {
      await editConfig(repo, () => '{ "schemaVersion": 2 }\n');
      const error = await expectRefusal(repo);
      expect(error.code).toBe('F001_INVALID_CONFIG');
      expect(error.subject).toBe('.farna/config.jsonc:schemaVersion');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a workspace capability in agent mode (the profile-mode invariant)', async () => {
    const repo = await createTempRepo('profile');
    try {
      await editConfig(repo, (text) => text.replace('{ "active": "builder" }', '{}'));
      const error = await expectRefusal(repo);
      expect(error.code).toBe('F001_INVALID_CONFIG');
      expect(error.message).toContain('requires profile mode');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses an active persona that names no persona declared in the source', async () => {
    const repo = await createTempRepo('profile');
    try {
      await editConfig(repo, (text) => text.replace('"active": "builder"', '"active": "ghost"'));
      const error = await expectRefusal(repo);
      expect(error.code).toBe('F001_INVALID_CONFIG');
      expect(error.subject).toBe('.farna/config.jsonc');
      expect(error.message).toContain('"ghost" names no persona');
    } finally {
      await repo.cleanup();
    }
  });

  it.skipIf(skipSymlinks)('refuses a symlinked source file with F003', async () => {
    const repo = await createTempRepo('demo');
    const outside = await createEmptyTempDir();
    try {
      const target = join(outside.root, 'builder.yaml');
      await writeFile(target, 'kind: persona\n', 'utf8');
      await symlink(target, join(repo.root, '.farna/personas/linked.yaml'));
      const error = await expectRefusal(repo);
      expect(error.code).toBe('F003_PATH_UNSAFE');
      expect(error.subject).toBe('.farna/personas/linked.yaml');
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });
});
