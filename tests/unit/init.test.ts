import { stat } from 'node:fs/promises';
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
