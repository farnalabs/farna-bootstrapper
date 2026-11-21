import { mkdir, readFile, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../src/cli/commands/init.js';
import { loadConfig } from '../../src/config/load.js';
import { FarnaError } from '../../src/core/errors.js';
import { createEmptyTempDir, hashTree, listFiles, readText } from '../support/temp-repo.js';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('init', () => {
  it('creates the config, the empty directories and the gitignore lines', async () => {
    const repo = await createEmptyTempDir();
    try {
      const result = await runInit(repo.root);
      expect(result.configPath).toBe('.farna/config.jsonc');

      const config = await loadConfig(repo.root);
      expect(config.schemaVersion).toBe(1);
      expect(Object.keys(config.targets)).toEqual(['claudecode']);
      expect(await exists(join(repo.root, '.farna/personas'))).toBe(true);
      expect(await exists(join(repo.root, '.farna/resources'))).toBe(true);

      const files = await listFiles(repo.root);
      expect(files).toEqual(['.farna/config.jsonc', '.gitignore']);

      const gitignore = await readText(repo.root, '.gitignore');
      expect(gitignore).toContain('.farna/local.jsonc');
      expect(gitignore).toContain('.farna/.journal.json');
      expect(result.nextStep).toContain('farna-bootstrapper generate');
    } finally {
      await repo.cleanup();
    }
  });

  it('fails a .gitignore directory with a typed error and changes nothing, then retries', async () => {
    const repo = await createEmptyTempDir();
    try {
      await mkdir(join(repo.root, '.gitignore'));
      let failure: FarnaError | undefined;
      try {
        await runInit(repo.root);
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F001_INVALID_CONFIG');
      expect(failure?.subject).toBe('.gitignore');
      expect(await exists(join(repo.root, '.farna'))).toBe(false);
      expect(await listFiles(repo.root)).toEqual([]);

      await rmdir(join(repo.root, '.gitignore'));
      const result = await runInit(repo.root);
      expect(result.ok).toBe(true);
      expect(await exists(join(repo.root, '.farna/config.jsonc'))).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('rolls back the directories it created when a later preflight fails', async () => {
    const repo = await createEmptyTempDir();
    try {
      await mkdir(join(repo.root, '.farna'));
      // `resources` is a file, so the later directory step must fail after
      // `personas` has already been created by this invocation.
      await writeFile(join(repo.root, '.farna/resources'), 'not a directory', 'utf8');
      await expect(runInit(repo.root)).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: '.farna/resources',
      });
      expect(await exists(join(repo.root, '.farna/personas'))).toBe(false);
      expect(await exists(join(repo.root, '.farna/config.jsonc'))).toBe(false);
      expect(await readFile(join(repo.root, '.farna/resources'), 'utf8')).toBe('not a directory');
    } finally {
      await repo.cleanup();
    }
  });

  it('appends to an existing .gitignore using its own line ending', async () => {
    const repo = await createEmptyTempDir();
    try {
      await writeFile(join(repo.root, '.gitignore'), 'node_modules/\r\ndist/\r\n', 'utf8');
      await runInit(repo.root);
      const text = await readFile(join(repo.root, '.gitignore'), 'utf8');
      expect(text).toContain('.farna/local.jsonc\r\n');
      expect(text).toContain('.farna/.journal.json\r\n');
      // Every newline in the appended region must be CRLF: no mixed endings.
      expect(text.split('\r\n').join('')).not.toContain('\n');
    } finally {
      await repo.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked .gitignore without touching the repository',
    async () => {
      const repo = await createEmptyTempDir();
      const outside = await createEmptyTempDir();
      try {
        const target = join(outside.root, 'gitignore');
        await writeFile(target, '', 'utf8');
        await symlink(target, join(repo.root, '.gitignore'), 'file');
        await expect(runInit(repo.root)).rejects.toMatchObject({
          code: 'F001_INVALID_CONFIG',
          subject: '.gitignore',
        });
        expect(await exists(join(repo.root, '.farna'))).toBe(false);
        expect(await readFile(target, 'utf8')).toBe('');
      } finally {
        await repo.cleanup();
        await outside.cleanup();
      }
    },
  );

  it('returns a typed error when .farna is a regular file', async () => {
    const repo = await createEmptyTempDir();
    try {
      await writeFile(join(repo.root, '.farna'), 'not a directory', 'utf8');
      let failure: FarnaError | undefined;
      try {
        await runInit(repo.root);
      } catch (error) {
        expect(error).toBeInstanceOf(FarnaError);
        failure = error as FarnaError;
      }
      expect(failure?.code).toBe('F001_INVALID_CONFIG');
      expect(failure?.subject).toBe('.farna');
      expect(failure?.message).toContain('not a directory');
      expect(await readFile(join(repo.root, '.farna'), 'utf8')).toBe('not a directory');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses to overwrite an existing source root and writes nothing', async () => {
    const repo = await createEmptyTempDir();
    try {
      await runInit(repo.root);
      const before = await hashTree(repo.root);
      await expect(runInit(repo.root)).rejects.toBeInstanceOf(FarnaError);
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });
});
