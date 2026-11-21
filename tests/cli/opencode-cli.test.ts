import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTempRepo } from '../support/temp-repo.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const CLI = join(ROOT, 'dist', 'cli', 'main.js');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

type CliRun = { code: number; stdout: string; stderr: string };

async function runCli(cwd: string, args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

function parseObject(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`expected a JSON object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function arrayOf<T>(value: Record<string, unknown>, key: string): T[] {
  const array = value[key];
  if (!Array.isArray(array)) {
    throw new Error(`expected ${key} to be an array`);
  }
  return array as T[];
}

describe('the built CLI on the opencode target', () => {
  beforeAll(async () => {
    await execFileAsync(NPM, ['run', 'build'], { cwd: ROOT, timeout: 180_000 });
  }, 180_000);

  it('refuses a workspace resource in agent mode with a typed F001', async () => {
    const repo = await createTempRepo('opencode');
    try {
      await appendFile(join(repo.root, '.farna/personas/builder.yaml'), '  - mcp/scan\n', 'utf8');
      const result = await runCli(repo.root, ['generate', '--json']);
      expect(result.code).toBe(1);
      const body = parseObject(result.stdout);
      expect(body).toMatchObject({
        schemaVersion: 1,
        command: 'generate',
        ok: false,
        exitCode: 1,
        code: 'F001_INVALID_CONFIG',
        subject: '.farna/personas/builder.yaml',
      });
      expect(String(body['message'])).toContain('mcp/scan');
      expect(String(body['message'])).toContain('builder');
      expect(String(body['message'])).toContain('requires profile mode');
      expect(result.stderr).toContain('requires profile mode');
    } finally {
      await repo.cleanup();
    }
  }, 120_000);

  it('checks clean and turns drift into the drift exit code and payload', async () => {
    const repo = await createTempRepo('opencode');
    try {
      const generated = await runCli(repo.root, ['generate']);
      expect(generated.code).toBe(0);

      const clean = await runCli(repo.root, ['check', '--json']);
      expect(clean.code).toBe(0);
      expect(parseObject(clean.stdout)).toMatchObject({ ok: true, exitCode: 0 });

      await appendFile(join(repo.root, '.opencode/agents/builder.md'), '\nmanual\n', 'utf8');
      const drifted = await runCli(repo.root, ['check', '--json']);
      expect(drifted.code).toBe(1);
      const body = parseObject(drifted.stdout);
      expect(body).toMatchObject({ ok: false, exitCode: 1, code: 'F007_DRIFT' });
      expect(arrayOf<{ path: string }>(body, 'drift').map((item) => item.path)).toContain(
        '.opencode/agents/builder.md',
      );
      // `check` drift is a result, not a typed error: stdout is the one JSON
      // document and stderr is empty, so a consumer reads the payload only.
      expect(drifted.stderr).toBe('');
    } finally {
      await repo.cleanup();
    }
  }, 120_000);

  it('dry-runs without writing and reports the plan', async () => {
    const repo = await createTempRepo('opencode');
    try {
      const result = await runCli(repo.root, ['generate', '--dry-run', '--json']);
      expect(result.code).toBe(0);
      const body = parseObject(result.stdout);
      expect(body).toMatchObject({ dryRun: true, target: 'opencode' });
      const files = arrayOf<{ path: string; status: string }>(body, 'files');
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((file) => file.status === 'would-write')).toBe(true);
      expect(files.some((file) => file.path === 'opencode.jsonc')).toBe(false);
      await expect(readFileOrUndefined(join(repo.root, 'opencode.jsonc'))).resolves.toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  }, 120_000);
});

async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
