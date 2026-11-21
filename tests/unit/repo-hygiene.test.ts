import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import {
  DEFAULT_TARGET,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  SCHEMA_VERSION,
  SUPPORTED_TARGETS,
  WARNING_CODES,
} from '../../src/core/constants.js';

const SOURCE = new URL('../../src/', import.meta.url);

async function source(path: string): Promise<string> {
  return await readFile(new URL(path, SOURCE), 'utf8');
}

describe('constants and package metadata', () => {
  it('keeps PRODUCT_NAME and PRODUCT_VERSION equal to package.json', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { name: string; version: string };
    expect(PRODUCT_NAME).toBe(manifest.name);
    expect(PRODUCT_VERSION).toBe(manifest.version);
  });

  it('validates the config schema version from the constant, not a literal', () => {
    expect(
      configSchema.safeParse({ schemaVersion: SCHEMA_VERSION, targets: { [DEFAULT_TARGET]: {} } })
        .success,
    ).toBe(true);
    expect(
      configSchema.safeParse({ schemaVersion: 2, targets: { [DEFAULT_TARGET]: {} } }).success,
    ).toBe(false);
    expect(SUPPORTED_TARGETS).toContain(DEFAULT_TARGET);
  });

  it('does not reintroduce the retired dead exports', async () => {
    const constants = await source('core/constants.ts');
    expect(constants).not.toContain('MODELS_DIR');
    const json = await source('core/json.ts');
    expect(json).not.toContain('sha256File');
    expect(json).not.toContain('stripBom');
    const load = await source('source/load.ts');
    expect(load).not.toContain('assertUniqueIds');
  });

  it('pins this repository own golden artefacts to LF', async () => {
    const attributes = await readFile(new URL('../../.gitattributes', import.meta.url), 'utf8');
    // The golden file is compared byte for byte; a CRLF checkout must not fail
    // on a clean clone. The consumer patterns are written by `init`, not here.
    expect(attributes).toContain('/tests/golden/** text eol=lf');
  });

  it('names every warning code in the README', async () => {
    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
    for (const code of WARNING_CODES) {
      expect(readme, `README does not document ${code}`).toContain(code);
    }
  });

  it('ships no dangling schema URL in the source', async () => {
    const init = await source('cli/commands/init.ts');
    expect(init).not.toContain('farna.dev/schema');
  });
});
