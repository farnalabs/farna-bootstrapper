import { execFile } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
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

  it('generates profile mode and --persona overrides the configured active', async () => {
    const repo = await createTempRepo('profile');
    try {
      const generated = await runCli(repo.root, ['generate', '--persona', 'reviewer', '--json']);
      expect(generated.code).toBe(0);
      const body = parseObject(generated.stdout);
      expect(body).toMatchObject({
        schemaVersion: 1,
        command: 'generate',
        ok: true,
        exitCode: 0,
        target: 'opencode',
        mode: 'profile',
        activePersona: 'reviewer',
        dryRun: false,
      });
      const files = arrayOf<{ path: string }>(body, 'files').map((file) => file.path);
      expect(files).toContain('.opencode/agents/reviewer.md');
      expect(files).not.toContain('.opencode/agents/builder.md');
      expect(files).toContain('opencode.jsonc');

      const clean = await runCli(repo.root, ['check', '--persona', 'reviewer', '--json']);
      expect(clean.code).toBe(0);
      expect(parseObject(clean.stdout)).toMatchObject({
        ok: true,
        mode: 'profile',
        activePersona: 'reviewer',
      });
    } finally {
      await repo.cleanup();
    }
  }, 120_000);

  it('uses the drift code at the top level while keeping per-item codes in the array', async () => {
    const repo = await createTempRepo('profile');
    try {
      const generated = await runCli(repo.root, ['generate', '--persona', 'builder', '--json']);
      expect(generated.code).toBe(0);

      // A W107 item (inside our own skill directory) sorts before the drifted
      // `opencode.jsonc`, so it is drift[0] without being the run's failure kind.
      await writeFile(
        join(repo.root, '.opencode/skills/secure-review/scripts/a-extra.sh'),
        'echo extra\n',
        'utf8',
      );
      const configPath = join(repo.root, 'opencode.jsonc');
      const document = JSON.parse(await readFile(configPath, 'utf8')) as {
        mcp: { servers: Record<string, unknown> };
      };
      document.mcp.servers['scan'] = { type: 'local', command: ['npx', 'different'] };
      await writeFile(configPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

      const result = await runCli(repo.root, ['check', '--persona', 'builder', '--json']);
      expect(result.code).toBe(1);
      const body = parseObject(result.stdout);
      expect(body['code']).toBe('F007_DRIFT');
      const drift = arrayOf<{ code: string; path: string }>(body, 'drift');
      expect(drift[0]).toMatchObject({
        code: 'W107_OUTSIDE_OWNERSHIP',
        path: '.opencode/skills/secure-review/scripts/a-extra.sh',
      });
      expect(drift.some((item) => item.code === 'F007_DRIFT')).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 120_000);

  it('requires --adopt to take over existing outputs and reports what it adopted', async () => {
    const repo = await createTempRepo('profile');
    try {
      const userConfig = '// mine\n{\n  "theme": "dark"\n}\n';
      await writeFile(join(repo.root, 'opencode.jsonc'), userConfig, 'utf8');

      const refused = await runCli(repo.root, ['generate', '--persona', 'builder', '--json']);
      expect(refused.code).toBe(1);
      const failure = parseObject(refused.stdout);
      expect(failure).toMatchObject({ ok: false, code: 'F007_DRIFT' });
      expect(String(failure['message'])).toContain('.farna/lock.json is missing');
      expect(String(failure['message'])).toContain('opencode.jsonc');

      const adopted = await runCli(repo.root, [
        'generate',
        '--persona',
        'builder',
        '--adopt',
        '--json',
      ]);
      expect(adopted.code).toBe(0);
      const body = parseObject(adopted.stdout);
      expect(arrayOf<string>(body, 'adopted')).toContain('opencode.jsonc');
      const after = await readFile(join(repo.root, 'opencode.jsonc'), 'utf8');
      expect(after).toContain('// mine');
      expect(after).toContain('"theme": "dark"');
      expect(after).toContain('"scan"');
    } finally {
      await repo.cleanup();
    }
  }, 120_000);

  it('documents profile mode and --persona in help', async () => {
    const root = await runCli(ROOT, ['--help']);
    expect(root.code).toBe(0);
    expect(root.stdout).toContain('Profile mode');
    const generate = await runCli(ROOT, ['generate', '--help']);
    expect(generate.code).toBe(0);
    expect(generate.stdout).toContain('--persona');
    expect(generate.stdout).toContain('--adopt');
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
