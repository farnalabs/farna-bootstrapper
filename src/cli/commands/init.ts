import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_FILE, PERSONAS_DIR, RESOURCES_DIR, ROOT_DIR } from '../../core/constants.js';
import { invalidConfig } from '../../core/errors.js';

export type InitResult = {
  ok: true;
  root: string;
  configPath: string;
  created: string[];
  nextStep: string;
};

const CONFIG_TEMPLATE = `{
  // Farna Bootstrapper source root. Generated files are committed.
  "$schema": "https://farna.dev/schema/farna-bootstrapper/config.schema.json",
  "schemaVersion": 1,
  "targets": {
    "claudecode": {}
  }
}
`;

const GITIGNORE_LINES = ['.farna/local.jsonc', '.farna/.journal.json'];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function updateGitignore(repoRoot: string): Promise<void> {
  const path = join(repoRoot, '.gitignore');
  const existing = (await exists(path)) ? await readFile(path, 'utf8') : '';
  const lines = existing.split('\n').map((line) => line.trim());
  const missing = GITIGNORE_LINES.filter((line) => !lines.includes(line));
  if (missing.length === 0) {
    return;
  }
  const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
  await writeFile(path, `${prefix}${missing.join('\n')}\n`, 'utf8');
}

/**
 * Create the source root. Refuses to overwrite an existing config: `init` is
 * never destructive.
 */
export async function runInit(repoRoot: string): Promise<InitResult> {
  const rootRelative = ROOT_DIR;
  const configRelative = `${ROOT_DIR}/${CONFIG_FILE}`;
  const configAbsolute = join(repoRoot, ROOT_DIR, CONFIG_FILE);

  if (await exists(configAbsolute)) {
    throw invalidConfig('a source root already exists', {
      subject: configRelative,
      action: 'edit the existing config, or remove it deliberately before re-initialising',
    });
  }

  await mkdir(join(repoRoot, ROOT_DIR, PERSONAS_DIR), { recursive: true });
  await mkdir(join(repoRoot, ROOT_DIR, RESOURCES_DIR), { recursive: true });
  await writeFile(configAbsolute, CONFIG_TEMPLATE, 'utf8');
  await updateGitignore(repoRoot);

  return {
    ok: true,
    root: rootRelative,
    configPath: configRelative,
    created: [configRelative, `${ROOT_DIR}/${PERSONAS_DIR}/`, `${ROOT_DIR}/${RESOURCES_DIR}/`],
    nextStep:
      'Add personas to .farna/personas/*.yaml and rules to .farna/resources/rules/, then run "farna-bootstrapper generate".',
  };
}
