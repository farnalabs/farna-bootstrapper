import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import {
  CONFIG_PATH,
  isOsMetadataName,
  MANAGED_FILE_MAX_BYTES,
  PERSONAS_DIR,
  RESOURCES_DIR,
  ROOT_DIR,
} from '../core/constants.js';
import { pathUnsafe } from '../core/errors.js';
import { readBoundedBytes } from '../core/fs.js';
import { canonicalJson, compareCodepoints, sha256Hex } from '../core/json.js';

const SOURCE_DIRECTORIES = [`${ROOT_DIR}/${PERSONAS_DIR}`, `${ROOT_DIR}/${RESOURCES_DIR}`];

async function listSourceFiles(
  repoRoot: string,
  directory: string,
  collected: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(repoRoot, directory), { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw pathUnsafe(`cannot read ${directory}`, {
      subject: directory,
      action: 'make the source directory readable and re-run',
      cause: error,
    });
  }
  for (const entry of entries.sort((a, b) => compareCodepoints(a.name, b.name))) {
    if (isOsMetadataName(entry.name)) {
      continue;
    }
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw pathUnsafe(`symlink not allowed: ${path}`, {
        subject: path,
        action: 'replace the symbolic link with a real file or directory',
      });
    }
    if (entry.isDirectory()) {
      await listSourceFiles(repoRoot, path, collected);
      continue;
    }
    if (entry.isFile()) {
      collected.push(path);
    }
  }
}

/**
 * A digest over the **raw** config bytes, the parsed config and **every**
 * persona and resource file, including the ones that are not live in the
 * current mode.
 *
 * Without it `check` could not see a change to a non-live persona's
 * declaration: profile mode resolves every persona but renders only the active
 * one, so editing the inactive persona's rule changed no managed byte. The
 * digest makes that edit visible as drift, which is what "every declaration is
 * validated" already promised.
 *
 * The raw config bytes are hashed as well as the parsed value: a comment or
 * whitespace edit in `config.jsonc` changes the committed source but not the
 * parsed object. Hashing the raw bytes makes it drift, exactly like a comment
 * edit in a persona file (whose whole bytes are hashed below).
 */
export async function sourceConfigDigest(repoRoot: string, config: Config): Promise<string> {
  const configBytes = await readBoundedBytes(join(repoRoot, CONFIG_PATH), CONFIG_PATH, {
    action: 'make the config readable and re-run',
    maxBytes: MANAGED_FILE_MAX_BYTES,
  });
  const files: string[] = [];
  for (const directory of SOURCE_DIRECTORIES) {
    await listSourceFiles(repoRoot, directory, files);
  }
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const path of files.sort(compareCodepoints)) {
    const bytes = await readBoundedBytes(join(repoRoot, path), path, {
      action: 'make the source file readable and re-run',
      maxBytes: MANAGED_FILE_MAX_BYTES,
    });
    entries.push({ path, sha256: sha256Hex(bytes) });
  }
  return sha256Hex(
    canonicalJson({ configRawSha256: sha256Hex(configBytes), config, files: entries }),
  );
}
