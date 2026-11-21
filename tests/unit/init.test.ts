import { chmod, lstat, mkdir, readFile, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit, writeGitignore } from '../../src/cli/commands/init.js';
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
      expect(files).toEqual(['.farna/config.jsonc', '.gitattributes', '.gitignore']);

      const gitignore = await readText(repo.root, '.gitignore');
      expect(gitignore).toContain('.farna/local.jsonc');
      expect(gitignore).toContain('.farna/.journal.json');
      // OS metadata is ignored by the source loader, so it is ignored by git.
      expect(gitignore).toContain('.DS_Store');
      expect(gitignore).toContain('Thumbs.db');
      expect(gitignore).toContain('desktop.ini');

      // The consumer's own .gitattributes pins the two generated paths to LF;
      // `check` compares bytes, so a CRLF checkout must not look like drift.
      const attributes = await readText(repo.root, '.gitattributes');
      expect(attributes).toContain('/.claude/agents/** text eol=lf');
      expect(attributes).toContain('/.farna/lock.json text eol=lf');
      // The rename moved a file this run created, never a link it followed.
      expect((await lstat(join(repo.root, '.gitignore'))).isSymbolicLink()).toBe(false);
      expect(result.nextStep).toContain('farna-bootstrapper generate');
    } finally {
      await repo.cleanup();
    }
  });

  it('does not write a dangling $schema URL into the config', async () => {
    const repo = await createEmptyTempDir();
    try {
      await runInit(repo.root);
      const config = await readFile(join(repo.root, '.farna/config.jsonc'), 'utf8');
      expect(config).not.toContain('$schema');
      expect(config).not.toContain('https://');
      expect(config).toContain('"schemaVersion": 1');
      expect(config).toContain('"claudecode": {}');
    } finally {
      await repo.cleanup();
    }
  });

  it('never follows a pre-planted staging symlink over .gitignore', async () => {
    const repo = await createEmptyTempDir();
    const outside = await createEmptyTempDir();
    try {
      const victim = join(outside.root, 'victim');
      await writeFile(victim, 'VICTIM ORIGINAL', 'utf8');
      await writeFile(join(repo.root, '.gitignore'), 'keep-me\n', 'utf8');
      // The old name was predictable (`.gitignore.farna-tmp-<pid>`), so an
      // attacker could plant exactly this link. The seam reproduces it.
      const planted = join(repo.root, '.gitignore.farna-tmp-planted');
      await symlink(victim, planted, 'file');

      await expect(
        writeGitignore(join(repo.root, '.gitignore'), 'replacement\n', () => planted),
      ).rejects.toMatchObject({ code: 'F001_INVALID_CONFIG', subject: '.gitignore' });

      // The failed create must not delete the object at the temporary name:
      // this call did not create it, so it is not this call's to remove.
      expect((await lstat(planted)).isSymbolicLink()).toBe(true);
      expect(await readFile(victim, 'utf8')).toBe('VICTIM ORIGINAL');
      expect((await lstat(join(repo.root, '.gitignore'))).isSymbolicLink()).toBe(false);
      expect(await readFile(join(repo.root, '.gitignore'), 'utf8')).toBe('keep-me\n');
    } finally {
      await repo.cleanup();
      await outside.cleanup();
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

  it('appends ASCII lines to a non-UTF-8 .gitignore without rewriting its bytes', async () => {
    const repo = await createEmptyTempDir();
    try {
      // 0xE9 is a lone Latin-1 byte: not valid UTF-8, and `readFile(...,'utf8')`
      // would silently replace it with U+FFFD and write that back.
      const original = Buffer.from([0x23, 0x20, 0xe9, 0x0a]);
      await writeFile(join(repo.root, '.gitignore'), original);

      const result = await runInit(repo.root);
      const after = await readFile(join(repo.root, '.gitignore'));
      expect(after.subarray(0, original.length).equals(original)).toBe(true);
      expect(after.toString('latin1')).toContain('.farna/local.jsonc');
      expect(after.toString('latin1')).toContain('.farna/.journal.json');
      expect(result.updated).toContain('.gitignore');
    } finally {
      await repo.cleanup();
    }
  });

  it('appends the consumer patterns to an existing .gitattributes', async () => {
    const repo = await createEmptyTempDir();
    try {
      await writeFile(join(repo.root, '.gitattributes'), '* text=auto\n', 'utf8');
      const result = await runInit(repo.root);
      const attributes = await readText(repo.root, '.gitattributes');
      expect(attributes.startsWith('* text=auto\n')).toBe(true);
      expect(attributes).toContain('/.claude/agents/** text eol=lf');
      expect(attributes).toContain('/.farna/lock.json text eol=lf');
      expect(result.updated).toContain('.gitattributes');
    } finally {
      await repo.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'preserves the existing .gitignore mode instead of making it 0600',
    async () => {
      const repo = await createEmptyTempDir();
      try {
        await writeFile(join(repo.root, '.gitignore'), 'node_modules/\n', 'utf8');
        await chmod(join(repo.root, '.gitignore'), 0o640);
        await runInit(repo.root);
        expect((await stat(join(repo.root, '.gitignore'))).mode & 0o777).toBe(0o640);
      } finally {
        await repo.cleanup();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'creates a new .gitignore with the umask mode, not a private 0600',
    async () => {
      const repo = await createEmptyTempDir();
      try {
        await runInit(repo.root);
        expect((await stat(join(repo.root, '.gitignore'))).mode & 0o777).toBe(
          0o666 & ~process.umask(),
        );
      } finally {
        await repo.cleanup();
      }
    },
  );
});
