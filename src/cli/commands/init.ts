import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  COMMANDS_DIR,
  CONFIG_FILE,
  DEFAULT_TARGET,
  GITATTRIBUTES_LINES,
  GITIGNORE_LINES,
  HOOKS_DIR,
  MANAGED_FILE_MAX_BYTES,
  MCP_DIR,
  PERMISSION_FILE_EXT,
  PERMISSIONS_DIR,
  PERSONA_FILE_EXT,
  PERSONAS_DIR,
  PRODUCT_NAME,
  RESOURCES_DIR,
  ROOT_DIR,
  RULE_FILE_EXT,
  RULES_DIR,
  SCHEMA_VERSION,
  SKILLS_DIR,
  STAGING_INFIX,
} from '../../core/constants.js';
import { FarnaError, invalidConfig } from '../../core/errors.js';
import { describeFsError, readBoundedBytes } from '../../core/fs.js';
import { assertRealDirectory, lstatOrUndefined } from '../../core/paths.js';

export type InitResult = {
  ok: true;
  root: string;
  configPath: string;
  /** Paths this invocation created, including the two shared ignore/attribute files. */
  created: string[];
  /** Existing shared files this invocation appended to. */
  updated: string[];
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

/**
 * Append the lines a shared text file is missing, preserving every byte already
 * there. The existing file is decoded with `latin1` only to find line boundaries
 * and compare ASCII lines: that map is byte-for-byte reversible, so a
 * `.gitignore` in Latin-1 (or any other encoding) keeps its original bytes and
 * only the new ASCII lines are added. Decoding as UTF-8 would replace an invalid
 * byte with U+FFFD and write the lossy text back.
 */
export function appendMissingLines(existing: Buffer, lines: readonly string[]): Buffer | undefined {
  const text = existing.toString('latin1');
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const eol = crlf > lf ? '\r\n' : '\n';
  const present = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) {
    return undefined;
  }
  const endsWithNewline = existing.length === 0 || existing[existing.length - 1] === 0x0a;
  const prefix = endsWithNewline ? existing : Buffer.concat([existing, Buffer.from(eol, 'latin1')]);
  return Buffer.concat([prefix, Buffer.from(`${missing.join(eol)}${eol}`, 'latin1')]);
}

export type TemporaryName = (path: string) => string;

/** An unpredictable sibling name: a pre-planted symlink cannot guess it. */
export function defaultTemporaryName(path: string): string {
  return `${path}${STAGING_INFIX}${process.pid}-${randomUUID()}`;
}

/** The mode an existing file had, or the umask-implied mode for a new file. */
async function targetMode(path: string, subject: string): Promise<number> {
  const stats = await lstatOrUndefined(path, subject);
  return stats?.isFile() === true ? stats.mode & 0o777 : 0o666 & ~process.umask();
}

/**
 * Replace a file atomically. The temporary is created with `O_EXCL`, so a path
 * an attacker planted (a symlink to a victim file, or any other object) makes
 * the create fail instead of being followed; the `stat` of the opened handle
 * proves the opened object is a regular file (the path may have been swapped
 * since). The rename then moves a file this call created over the target, never
 * a link. The target's existing mode is preserved; a new file uses the umask.
 *
 * A failed CREATE removes nothing: the object at the temporary name was not
 * created by this call, so deleting it would delete something the caller did not
 * own.
 */
export async function writeAtomicFile(
  path: string,
  contents: string | Uint8Array,
  subject: string,
  action: string,
  temporaryName: TemporaryName = defaultTemporaryName,
): Promise<void> {
  const temporary = temporaryName(path);
  const mode = await targetMode(path, subject);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(temporary, 'wx', mode);
  } catch (error) {
    throw invalidConfig(`cannot update ${subject} (${describeFsError(error)})`, {
      subject,
      action,
      cause: error,
    });
  }
  try {
    const stats = await handle.stat();
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('staging path is not a regular file');
    }
    await handle.writeFile(contents);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw invalidConfig(`cannot update ${subject} (${describeFsError(error)})`, {
      subject,
      action,
      cause: error,
    });
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw invalidConfig(`cannot update ${subject} (${describeFsError(error)})`, {
      subject,
      action,
      cause: error,
    });
  }
}

/** Replace `.gitignore` atomically, preserving its bytes and mode. */
export async function writeGitignore(
  path: string,
  contents: string | Uint8Array,
  temporaryName: TemporaryName = defaultTemporaryName,
): Promise<void> {
  await writeAtomicFile(
    path,
    contents,
    '.gitignore',
    'make .gitignore writable and re-run init',
    temporaryName,
  );
}

/** Read a shared text file as raw bytes, refusing a link or a non-file. */
async function preflightSharedFile(path: string, subject: string): Promise<Buffer | undefined> {
  const stats = await lstatOrUndefined(path, subject);
  if (stats === undefined) {
    return undefined;
  }
  if (stats.isSymbolicLink()) {
    throw invalidConfig(`cannot update ${subject}: it is a symbolic link`, {
      subject,
      action: 'replace the symbolic link with a regular file',
    });
  }
  if (!stats.isFile()) {
    throw invalidConfig(`cannot update ${subject}: it is not a regular file`, {
      subject,
      action: 'replace it with a regular file, or remove it',
    });
  }
  return await readBoundedBytes(path, subject, {
    action: `make ${subject} readable and re-run init`,
    maxBytes: MANAGED_FILE_MAX_BYTES,
  });
}

/**
 * Create the source root. Refuses to overwrite an existing config: `init` is
 * never destructive. The whole command is atomic: the writes that can fail on
 * an ordinary filesystem state (`.gitignore`, `.gitattributes`) are preflighted
 * before anything is created, and a failure after creation removes what this
 * invocation created and restores the shared files byte for byte.
 */
export async function runInit(repoRoot: string): Promise<InitResult> {
  const rootRelative = ROOT_DIR;
  const configRelative = `${ROOT_DIR}/${CONFIG_FILE}`;
  const configAbsolute = join(repoRoot, ROOT_DIR, CONFIG_FILE);
  const gitignorePath = join(repoRoot, '.gitignore');
  const gitattributesPath = join(repoRoot, '.gitattributes');

  // Check `.farna` itself before probing anything below it: when it is a
  // regular file, lstat of `.farna/config.jsonc` raises ENOTDIR.
  await assertRealDirectory(join(repoRoot, ROOT_DIR), ROOT_DIR);
  const existingConfig = await lstatOrUndefined(configAbsolute, configRelative);
  if (existingConfig !== undefined) {
    throw invalidConfig('a source root already exists', {
      subject: configRelative,
      action: 'edit the existing config, or remove it deliberately before re-initialising',
    });
  }
  // Preflight every remaining path this invocation will touch before creating
  // anything.
  const gitignoreOriginal = await preflightSharedFile(gitignorePath, '.gitignore');
  const gitignoreNext =
    gitignoreOriginal === undefined
      ? Buffer.from(`${GITIGNORE_LINES.join('\n')}\n`)
      : appendMissingLines(gitignoreOriginal, GITIGNORE_LINES);
  const gitattributesOriginal = await preflightSharedFile(gitattributesPath, '.gitattributes');
  const gitattributesNext =
    gitattributesOriginal === undefined
      ? Buffer.from(`${GITATTRIBUTES_LINES.join('\n')}\n`)
      : appendMissingLines(gitattributesOriginal, GITATTRIBUTES_LINES);

  const createdDirectories: string[] = [];
  const createdFiles: string[] = [];
  const created = new Set<string>();
  const updated = new Set<string>();
  const sharedWrites: Array<{
    path: string;
    subject: string;
    original: Buffer | undefined;
    next: Buffer;
  }> = [];

  const ensureDirectory = async (path: string, subject: string): Promise<void> => {
    const stats = await assertRealDirectory(path, subject);
    if (stats === undefined) {
      try {
        await mkdir(path);
      } catch (error) {
        const now =
          describeFsError(error) === 'EEXIST' ? await lstatOrUndefined(path, subject) : undefined;
        if (now?.isDirectory() !== true) {
          throw error;
        }
        return;
      }
      createdDirectories.push(path);
    }
  };

  const rollback = async (): Promise<void> => {
    for (const entry of [...sharedWrites].reverse()) {
      try {
        if (entry.original === undefined) {
          await rm(entry.path, { force: true });
        } else {
          // Raw bytes: the file may not be UTF-8, and a text round-trip would
          // write back a replaced U+FFFD instead of the original byte.
          await writeFile(entry.path, entry.original);
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

  const recordStage = async (
    path: string,
    subject: string,
    original: Buffer | undefined,
    next: Buffer,
  ): Promise<void> => {
    sharedWrites.push({ path, subject, original, next });
    await writeAtomicFile(path, next, subject, `make ${subject} writable and re-run init`);
    (original === undefined ? created : updated).add(subject);
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
    await ensureDirectory(
      join(repoRoot, ROOT_DIR, RESOURCES_DIR, MCP_DIR),
      `${ROOT_DIR}/${RESOURCES_DIR}/${MCP_DIR}`,
    );
    await ensureDirectory(
      join(repoRoot, ROOT_DIR, RESOURCES_DIR, SKILLS_DIR),
      `${ROOT_DIR}/${RESOURCES_DIR}/${SKILLS_DIR}`,
    );
    await ensureDirectory(
      join(repoRoot, ROOT_DIR, RESOURCES_DIR, COMMANDS_DIR),
      `${ROOT_DIR}/${RESOURCES_DIR}/${COMMANDS_DIR}`,
    );
    await ensureDirectory(
      join(repoRoot, ROOT_DIR, RESOURCES_DIR, HOOKS_DIR),
      `${ROOT_DIR}/${RESOURCES_DIR}/${HOOKS_DIR}`,
    );

    createdFiles.push(configAbsolute);
    await writeFile(configAbsolute, configTemplate(), 'utf8');
    created.add(configRelative);

    if (gitignoreNext !== undefined) {
      await recordStage(gitignorePath, '.gitignore', gitignoreOriginal, gitignoreNext);
    }
    if (gitattributesNext !== undefined) {
      await recordStage(
        gitattributesPath,
        '.gitattributes',
        gitattributesOriginal,
        gitattributesNext,
      );
    }
  } catch (error) {
    await rollback();
    if (error instanceof FarnaError) {
      throw error;
    }
    throw invalidConfig(`init could not complete (${describeFsError(error)})`, {
      subject: ROOT_DIR,
      cause: error,
    });
  }

  return {
    ok: true,
    root: rootRelative,
    configPath: configRelative,
    created: [
      ...created,
      `${ROOT_DIR}/${PERSONAS_DIR}/`,
      `${ROOT_DIR}/${RESOURCES_DIR}/`,
      `${ROOT_DIR}/${RESOURCES_DIR}/${RULES_DIR}/`,
      `${ROOT_DIR}/${RESOURCES_DIR}/${PERMISSIONS_DIR}/`,
      `${ROOT_DIR}/${RESOURCES_DIR}/${MCP_DIR}/`,
      `${ROOT_DIR}/${RESOURCES_DIR}/${SKILLS_DIR}/`,
      `${ROOT_DIR}/${RESOURCES_DIR}/${COMMANDS_DIR}/`,
      `${ROOT_DIR}/${RESOURCES_DIR}/${HOOKS_DIR}/`,
    ],
    updated: [...updated],
    nextStep: `Add personas to ${ROOT_DIR}/${PERSONAS_DIR}/*${PERSONA_FILE_EXT}, rules to ${ROOT_DIR}/${RESOURCES_DIR}/${RULES_DIR}/*${RULE_FILE_EXT} and permissions to ${ROOT_DIR}/${RESOURCES_DIR}/${PERMISSIONS_DIR}/*${PERMISSION_FILE_EXT}, then run "${PRODUCT_NAME} generate".`,
  };
}
