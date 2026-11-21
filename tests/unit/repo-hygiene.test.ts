import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import {
  DEFAULT_TARGET,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  SCHEMA_VERSION,
  SUPPORTED_TARGETS,
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

  it('pins the committed artefacts to LF for a Windows checkout', async () => {
    const attributes = await readFile(new URL('../../.gitattributes', import.meta.url), 'utf8');
    expect(attributes).toContain('/.claude/agents/** text eol=lf');
    expect(attributes).toContain('/.farna/lock.json text eol=lf');
  });

  it('ships no dangling schema URL in the source', async () => {
    const init = await source('cli/commands/init.ts');
    expect(init).not.toContain('farna.dev/schema');
  });
});
