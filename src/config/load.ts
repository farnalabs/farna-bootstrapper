import { join } from 'node:path';
import { ZodError } from 'zod';
import { CONFIG_FILE, CONFIG_PATH, ROOT_DIR } from '../core/constants.js';
import { invalidConfig } from '../core/errors.js';
import { readUtf8File } from '../core/fs.js';
import { parseJsonc } from '../core/json.js';
import { assertRealDirectory, assertRealFile } from '../core/paths.js';
import { assertNoLocationCollisions } from './collision.js';
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
  const relative = CONFIG_PATH;
  await assertRealDirectory(join(repoRoot, ROOT_DIR), ROOT_DIR);
  await assertRealFile(path, relative);
  const text = await readUtf8File(path, relative, {
    action: 'run "farna-bootstrapper init" first',
  });

  const parsed = parseJsonc(text, { subject: relative });
  let config: Config;
  try {
    config = configSchema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      const described = describeZodError(error);
      throw invalidConfig(described.message, {
        subject: described.pointer === undefined ? relative : `${relative}:${described.pointer}`,
      });
    }
    throw error;
  }
  // Structural rule, enforced once for every command: two targets may not own
  // one location. It reads no source and needs no renderer, so it runs before
  // anything has been read, planned or written.
  assertNoLocationCollisions(config);
  return config;
}
