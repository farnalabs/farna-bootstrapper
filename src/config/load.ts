import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { CONFIG_FILE, ROOT_DIR } from '../core/constants.js';
import { invalidConfig } from '../core/errors.js';
import { parseJsonc } from '../core/json.js';
import { assertRealDirectory, assertRealFile } from '../core/paths.js';
import { type Config, configSchema } from './schema.js';

export function configPath(repoRoot: string): string {
  return join(repoRoot, ROOT_DIR, CONFIG_FILE);
}

function describeZodError(error: ZodError): { message: string; pointer?: string } {
  const issue = error.issues[0];
  if (issue === undefined) {
    return { message: 'config did not validate' };
  }
  const pointer = issue.path.join('.');
  return {
    message: issue.message,
    ...(pointer === '' ? {} : { pointer }),
  };
}

/** Read and strictly validate `.farna/config.jsonc`. Never returns a partial config. */
export async function loadConfig(repoRoot: string): Promise<Config> {
  const path = configPath(repoRoot);
  const relative = `${ROOT_DIR}/${CONFIG_FILE}`;
  await assertRealDirectory(join(repoRoot, ROOT_DIR), ROOT_DIR);
  await assertRealFile(path, relative);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw invalidConfig(`cannot read ${relative}`, {
      subject: relative,
      action: 'run "farna-bootstrapper init" first',
      cause: error,
    });
  }

  const parsed = parseJsonc(text, { subject: relative });
  try {
    return configSchema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      const described = describeZodError(error);
      throw invalidConfig(described.message, {
        subject: described.pointer === undefined ? relative : `${relative}:${described.pointer}`,
      });
    }
    throw error;
  }
}
