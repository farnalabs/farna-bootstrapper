import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONFIG_FILE,
  DEFAULT_TARGET,
  GITIGNORE_LINES,
  PERMISSIONS_DIR,
  PERSONAS_DIR,
  RESOURCES_DIR,
  ROOT_DIR,
  RULES_DIR,
  SCHEMA_VERSION,
  STAGING_INFIX,
} from '../../core/constants.js';
import { FarnaError, invalidConfig } from '../../core/errors.js';
import { assertRealDirectory, lstatOrUndefined } from '../../core/paths.js';

export type InitResult = {
  ok: true;
  root: string;
  configPath: string;
  created: string[];
  nextStep: string;
};

/**
 * The config `init` writes. Derived from the constants the schema validates, so
 * the template cannot drift from the version or target this build supports. It
 * carries no `$schema` URL: a URL that 404s is a dangling claim, and no schema
 * is published yet.
 */
export function configTemplate(): string {
  return `{
  // Farna Bootstrapper source root. Generated files are committed.
  "schemaVersion": ${SCHEMA_VERSION},
  "targets": {
    "${DEFAULT_TARGET}": {}
  }
}
`;
}

/** The line ending the existing file already uses; a new file uses LF. */
function detectLineEnding(text: string): string {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

async function preflightGitignore(path: string): Promise<string | undefined> {
  const stats = await lstatOrUndefined(path);
  if (stats === undefined) {
    return undefined;
  }
  if (stats.isSymbolicLink()) {
    throw invalidConfig('cannot update .gitignore: it is a symbolic link', {
      subject: '.gitignore',
      action: 'replace the symbolic link with a regular file',
    });
  }
  if (!stats.isFile()) {
    throw invalidConfig('cannot update .gitignore: it is not a regular file', {
      subject: '.gitignore',
      action: 'replace it with a regular file, or remove it',
    });
  }
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw invalidConfig('cannot read .gitignore', {
      subject: '.gitignore',
      action: 'make .gitignore readable and re-run init',
      cause: error,
    });
  }
}

function nextGitignore(existing: string): string | undefined {
  const eol = detectLineEnding(existing);
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  const missing = GITIGNORE_LINES.filter((line) => !lines.includes(line));
  if (missing.length === 0) {
    return undefined;
  }
  const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}${eol}`;
  return `${prefix}${missing.join(eol)}${eol}`;
}

export type TemporaryName = (path: string) => string;

/** An unpredictable sibling name: a pre-planted symlink cannot guess it. */
export function defaultTemporaryName(path: string): string {
  return `${path}${STAGING_INFIX}${process.pid}-${randomUUID()}`;
}

/**
 * Replace `.gitignore` atomically. The temporary is created with `O_EXCL`, so a
 * path an attacker planted (a symlink to a victim file, or any other object)
 * makes the create fail instead of being followed; the `lstat` after the open
 * proves the opened path is a regular file. The rename then moves a file this
 * call created over `.gitignore`, never a link.
 */
export async function writeGitignore(
  path: string,
  contents: string,
  temporaryName: TemporaryName = defaultTemporaryName,
): Promise<void> {
  const temporary = temporaryName(path);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
    } finally {
      await handle.close();
    }
    const stats = await lstat(temporary);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('staging path is not a regular file');
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw invalidConfig('cannot update .gitignore', {
      subject: '.gitignore',
      action: 'make .gitignore writable and re-run init',
      cause: error,
    });
  }
}

/**
 * Create the source root. Refuses to overwrite an existing config: `init` is
 * never destructive. The whole command is atomic: the one write that can fail
 * on an ordinary filesystem state (`.gitignore`) is preflighted before
 * anything is created, and a failure after creation removes what this
 * invocation created.
 */
export async function runInit(repoRoot: string): Promise<InitResult> {
  const rootRelative = ROOT_DIR;
  const configRelative = `${ROOT_DIR}/${CONFIG_FILE}`;
  const configAbsolute = join(repoRoot, ROOT_DIR, CONFIG_FILE);
  const gitignorePath = join(repoRoot, '.gitignore');

  // Check `.farna` itself before probing anything below it: when it is a
  // regular file, lstat of `.farna/config.jsonc` raises ENOTDIR.
  await assertRealDirectory(join(repoRoot, ROOT_DIR), ROOT_DIR);
  const existingConfig = await lstatOrUndefined(configAbsolute);
  if (existingConfig !== undefined) {
    throw invalidConfig('a source root already exists', {
      subject: configRelative,
      action: 'edit the existing config, or remove it deliberately before re-initialising',
    });
  }
  // Preflight every remaining path this invocation will touch before creating
  // anything.
  const gitignoreOriginal = await preflightGitignore(gitignorePath);
  const gitignoreNext =
    gitignoreOriginal === undefined
      ? `${GITIGNORE_LINES.join('\n')}\n`
      : nextGitignore(gitignoreOriginal);

  const createdDirectories: string[] = [];
  const createdFiles: string[] = [];
  let gitignoreWritten = false;

  const ensureDirectory = async (path: string, subject: string): Promise<void> => {
    const stats = await assertRealDirectory(path, subject);
    if (stats === undefined) {
      await mkdir(path);
      createdDirectories.push(path);
    }
  };

  const rollback = async (): Promise<void> => {
    if (gitignoreWritten) {
      try {
        if (gitignoreOriginal === undefined) {
          await rm(gitignorePath, { force: true });
        } else {
          await writeFile(gitignorePath, gitignoreOriginal, 'utf8');
        }
      } catch {
        // Best effort: the typed error below still names the failing path.
      }
    }
    for (const file of [...createdFiles].reverse()) {
      try {
        await rm(file, { force: true });
      } catch {
        // Best effort.
      }
    }
    for (const directory of [...createdDirectories].reverse()) {
      try {
        await rmdir(directory);
      } catch {
        // A non-empty directory means something other than init wrote to it.
      }
    }
  };

  try {
    await ensureDirectory(join(repoRoot, ROOT_DIR), ROOT_DIR);
    await ensureDirectory(join(repoRoot, ROOT_DIR, PERSONAS_DIR), `${ROOT_DIR}/${PERSONAS_DIR}`);
    await ensureDirectory(join(repoRoot, ROOT_DIR, RESOURCES_DIR), `${ROOT_DIR}/${RESOURCES_DIR}`);
    await ensureDirectory(
      join(repoRoot, ROOT_DIR, RESOURCES_DIR, RULES_DIR),
      `${ROOT_DIR}/${RESOURCES_DIR}/${RULES_DIR}`,
    );
    await ensureDirectory(
      join(repoRoot, ROOT_DIR, RESOURCES_DIR, PERMISSIONS_DIR),
      `${ROOT_DIR}/${RESOURCES_DIR}/${PERMISSIONS_DIR}`,
    );

    createdFiles.push(configAbsolute);
    await writeFile(configAbsolute, configTemplate(), 'utf8');

    if (gitignoreNext !== undefined) {
      await writeGitignore(gitignorePath, gitignoreNext);
      gitignoreWritten = true;
    }
  } catch (error) {
    await rollback();
    if (error instanceof FarnaError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw invalidConfig(`init could not complete: ${message}`, {
      subject: ROOT_DIR,
      cause: error,
    });
  }

  return {
    ok: true,
    root: rootRelative,
    configPath: configRelative,
    created: [
      configRelative,
      `${ROOT_DIR}/${PERSONAS_DIR}/`,
      `${ROOT_DIR}/${RESOURCES_DIR}/`,
      `${ROOT_DIR}/${RESOURCES_DIR}/${RULES_DIR}/`,
      `${ROOT_DIR}/${RESOURCES_DIR}/${PERMISSIONS_DIR}/`,
    ],
    nextStep:
      'Add personas to .farna/personas/*.yaml, rules to .farna/resources/rules/ and permissions to .farna/resources/permissions/, then run "farna-bootstrapper generate".',
  };
}
