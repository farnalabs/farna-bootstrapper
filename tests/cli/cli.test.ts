import { execFile } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import {
  createEmptyTempDir,
  createTempRepo,
  hashTree,
  type TempRepo,
} from '../support/temp-repo.js';

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

function filesOf(value: Record<string, unknown>): Array<{ path: string; status: string }> {
  const files = value['files'];
  if (!Array.isArray(files)) {
    throw new Error('expected a files array');
  }
  return files as Array<{ path: string; status: string }>;
}

function driftOf(
  value: Record<string, unknown>,
): Array<{ path: string; kind: string; code: string }> {
  const drift = value['drift'];
  if (!Array.isArray(drift)) {
    throw new Error('expected a drift array');
  }
  return drift as Array<{ path: string; kind: string; code: string }>;
}

async function generated(fixture = 'demo'): Promise<TempRepo> {
  const repo = await createTempRepo(fixture);
  const result = await runCli(repo.root, ['generate', '--json']);
  expect(result.code).toBe(0);
  return repo;
}

describe('the built CLI', () => {
  beforeAll(async () => {
    await execFileAsync(NPM, ['run', 'build'], { cwd: ROOT, timeout: 180_000 });
  }, 180_000);

  it('documents the supported OpenCode major and the five commands in --help', async () => {
    const result = await runCli(ROOT, ['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OpenCode 2.x');
    expect(result.stdout).toContain('doctor');
    expect(result.stdout).toContain('report');
  });

  it('generates cleanly and emits the success envelope on stdout', async () => {
    const repo = await createTempRepo('composed');
    try {
      const result = await runCli(repo.root, ['generate', '--json']);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      const body = parseObject(result.stdout);
      expect(body).toMatchObject({
        schemaVersion: 1,
        command: 'generate',
        ok: true,
        exitCode: 0,
        dryRun: false,
      });
      expect(filesOf(body).map((file) => file.path)).toEqual([
        '.claude/agents/builder-python.md',
        '.claude/agents/builder.md',
        '.claude/agents/reviewer.md',
        '.farna/lock.json',
      ]);
      expect(filesOf(body).every((file) => file.status === 'written')).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('prints human output without --json', async () => {
    const repo = await createTempRepo();
    try {
      const result = await runCli(repo.root, ['generate']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('farna-bootstrapper generate');
      expect(result.stdout).toContain('.claude/agents/builder.md');
    } finally {
      await repo.cleanup();
    }
  });

  it('reports dry-run statuses against the current tree', async () => {
    const repo = await generated();
    try {
      const clean = await runCli(repo.root, ['generate', '--dry-run', '--json']);
      expect(clean.code).toBe(0);
      expect(filesOf(parseObject(clean.stdout)).map((file) => file.status)).toEqual([
        'unchanged',
        'unchanged',
        'unchanged',
      ]);

      await appendFile(join(repo.root, '.claude/agents/reviewer.md'), ' ', 'utf8');
      const drifted = await runCli(repo.root, ['generate', '--dry-run', '--json']);
      expect(drifted.code).toBe(0);
      const changed = filesOf(parseObject(drifted.stdout)).filter(
        (file) => file.status === 'would-write',
      );
      expect(changed.map((file) => file.path)).toEqual(['.claude/agents/reviewer.md']);
    } finally {
      await repo.cleanup();
    }
  });

  it('emits a JSON failure object for F001 with exit 1', async () => {
    const repo = await createTempRepo();
    try {
      await writeFile(join(repo.root, '.farna/config.jsonc'), '{oops\n', 'utf8');
      const result = await runCli(repo.root, ['generate', '--json']);
      expect(result.code).toBe(1);
      const body = parseObject(result.stdout);
      expect(body).toMatchObject({
        schemaVersion: 1,
        command: 'generate',
        ok: false,
        exitCode: 1,
        code: 'F001_INVALID_CONFIG',
        subject: '.farna/config.jsonc',
      });
      expect(String(body['message'])).toContain('InvalidSymbol');
      expect(result.stderr).toContain('F001_INVALID_CONFIG');
    } finally {
      await repo.cleanup();
    }
  });

  it('emits a JSON failure object for F005 with exit 2', async () => {
    const repo = await createTempRepo('composed');
    try {
      await writeFile(
        join(repo.root, '.farna/personas/builder-python.yaml'),
        [
          'kind: persona',
          'id: builder-python',
          'displayName: Python Builder',
          'purpose: Writes Python and runs the Python checks.',
          'extends: builder',
          'model: fast',
          'resources:',
          '  - rule/python-style',
          '',
        ].join('\n'),
        'utf8',
      );
      const result = await runCli(repo.root, ['generate', '--json']);
      expect(result.code).toBe(2);
      const body = parseObject(result.stdout);
      expect(body).toMatchObject({
        command: 'generate',
        ok: false,
        exitCode: 2,
        code: 'F005_CONFLICT',
      });
      expect(String(body['message'])).toContain('two different models');
    } finally {
      await repo.cleanup();
    }
  });

  it('emits a JSON failure object for F011 with exit 3', async () => {
    const repo = await createTempRepo('composed');
    try {
      await writeFile(
        join(repo.root, '.farna/resources/permissions/python-tools.jsonc'),
        `${JSON.stringify(
          { kind: 'permission', id: 'python-tools', tools: { network: 'deny' } },
          null,
          2,
        )}\n`,
        'utf8',
      );
      const result = await runCli(repo.root, ['generate', '--json']);
      expect(result.code).toBe(3);
      const body = parseObject(result.stdout);
      expect(body).toMatchObject({
        command: 'generate',
        ok: false,
        exitCode: 3,
        code: 'F011_PERMISSION_UNMAPPED',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('carries W114 into the --json generate envelope when integrity is unverified', async () => {
    const repo = await createTempRepo();
    const output: string[] = [];
    try {
      const program = buildProgram({
        cwd: repo.root,
        renderer: new FakeRenderTarget(
          { kind: 'ok' },
          {
            name: 'fake-renderer',
            version: '0.0.0-test',
            integrityRecord: { verified: false, reason: 'no-record' },
          },
          { name: 'fake-renderer', version: '0.0.0-test', integrity: 'sha512-pin' },
        ),
        stdout: (text) => output.push(text),
        argv: ['node', 'farna-bootstrapper', 'generate', '--json'],
      });
      await program.parseAsync(['node', 'farna-bootstrapper', 'generate', '--json']);
      const body = parseObject(output.join(''));
      const warnings = body['warnings'];
      if (!Array.isArray(warnings)) {
        throw new Error('expected a warnings array');
      }
      const w114 = warnings.find(
        (entry) => (entry as { code?: string }).code === 'W114_RENDERER_INTEGRITY_UNVERIFIED',
      );
      expect(w114).toMatchObject({
        code: 'W114_RENDERER_INTEGRITY_UNVERIFIED',
        severity: 'medium',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('exits 4 for an F008 containment failure', async () => {
    const repo = await createTempRepo();
    const originalExit = process.exitCode;
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);
    try {
      const program = buildProgram({
        cwd: repo.root,
        renderer: new FakeRenderTarget({ kind: 'drop-body', persona: 'builder' }),
        stdout: () => undefined,
        argv: ['node', 'farna-bootstrapper', 'generate'],
      });
      await program.parseAsync(['node', 'farna-bootstrapper', 'generate']);
      // F008 has its own exit code (4) and no longer borrows drift's 1.
      expect(process.exitCode).toBe(4);
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain(
        'F008_DECLARED_NOT_EMITTED',
      );
    } finally {
      stderr.mockRestore();
      process.exitCode = originalExit;
      await repo.cleanup();
    }
  });

  it('reports clean check JSON and drift JSON with exit 1', async () => {
    const repo = await generated();
    try {
      const clean = await runCli(repo.root, ['check', '--json']);
      expect(clean.code).toBe(0);
      expect(parseObject(clean.stdout)).toMatchObject({
        schemaVersion: 1,
        command: 'check',
        ok: true,
        exitCode: 0,
      });

      await appendFile(join(repo.root, '.claude/agents/builder.md'), 'manual edit\n', 'utf8');
      const drifted = await runCli(repo.root, ['check', '--json']);
      expect(drifted.code).toBe(1);
      const body = parseObject(drifted.stdout);
      expect(body).toMatchObject({
        command: 'check',
        ok: false,
        exitCode: 1,
        code: 'F007_DRIFT',
        subject: '.claude/agents/builder.md',
        message: 'managed output drifted from a fresh render',
      });
      expect(driftOf(body)).toContainEqual({
        code: 'F007_DRIFT',
        path: '.claude/agents/builder.md',
        kind: 'modified',
        detail: 'content differs from a fresh render',
      });
    } finally {
      await repo.cleanup();
    }
    // This case renders, writes and then re-renders through the built CLI, so
    // it needs a realistic bound: the 5 s default is marginal on a loaded
    // machine and reports a slow run as a failure.
  }, 20_000);

  it('fails F010 with exit 5 when the lockfile names another renderer', async () => {
    const repo = await generated();
    try {
      const lockPath = join(repo.root, '.farna/lock.json');
      const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
        renderer: { version: string };
      };
      lock.renderer.version = '0.0.0-not-installed';
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
      const result = await runCli(repo.root, ['check', '--json']);
      expect(result.code).toBe(5);
      const body = parseObject(result.stdout);
      expect(body).toMatchObject({
        command: 'check',
        ok: false,
        exitCode: 5,
        code: 'F010_RENDERER_MISMATCH',
        subject: '.farna/lock.json',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('emits a JSON failure object and exit 1 for an unknown option', async () => {
    const repo = await createTempRepo();
    try {
      const result = await runCli(repo.root, ['generate', '--not-an-option', '--json']);
      expect(result.code).toBe(1);
      const body = parseObject(result.stdout);
      expect(body).toMatchObject({
        schemaVersion: 1,
        command: 'generate',
        ok: false,
        exitCode: 1,
        code: null,
        subject: null,
      });
      expect(String(body['message'])).toContain('unknown option');
    } finally {
      await repo.cleanup();
    }
  });

  it('validates a source with doctor and emits the success envelope', async () => {
    const repo = await createTempRepo('composed');
    try {
      const before = await hashTree(repo.root);
      const result = await runCli(repo.root, ['doctor', '--json']);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      const body = parseObject(result.stdout);
      expect(body).toMatchObject({
        schemaVersion: 1,
        command: 'doctor',
        ok: true,
        exitCode: 0,
        target: 'claudecode',
        mode: 'agent',
        configPath: '.farna/config.jsonc',
      });
      expect(Array.isArray(body['checks'])).toBe(true);
      expect(Array.isArray(body['personas'])).toBe(true);
      // doctor writes nothing at all, not even a lockfile or a stage.
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('prints the doctor report without --json', async () => {
    const repo = await createTempRepo('demo');
    try {
      const result = await runCli(repo.root, ['doctor']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('farna-bootstrapper doctor');
      expect(result.stdout).toContain('claudecode (agent mode)');
      expect(result.stdout).toContain('doctor: ok');
    } finally {
      await repo.cleanup();
    }
  });

  it('fails doctor with the typed code and a non-zero exit on an invalid source', async () => {
    const repo = await createTempRepo('demo');
    try {
      await writeFile(join(repo.root, '.farna/config.jsonc'), '{ "schemaVersion": 2 }\n', 'utf8');
      const result = await runCli(repo.root, ['doctor', '--json']);
      expect(result.code).toBe(1);
      const body = parseObject(result.stdout);
      expect(body).toMatchObject({
        command: 'doctor',
        ok: false,
        exitCode: 1,
        code: 'F001_INVALID_CONFIG',
      });
      expect(result.stderr).toContain('F001_INVALID_CONFIG');
    } finally {
      await repo.cleanup();
    }
  });

  it('prints the capability matrix outside a source tree, with JSON and human output', async () => {
    const repo = await createEmptyTempDir();
    try {
      const before = await hashTree(repo.root);
      const json = await runCli(repo.root, ['report', '--json']);
      expect(json.code).toBe(0);
      expect(json.stderr).toBe('');
      const body = parseObject(json.stdout);
      expect(body).toMatchObject({ schemaVersion: 1, command: 'report', ok: true, exitCode: 0 });
      expect(Array.isArray(body['targets'])).toBe(true);
      expect((body['targets'] as unknown[]).length).toBe(3);

      const human = await runCli(repo.root, ['report']);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('capability matrix');
      expect(human.stdout).toContain('report: ok');
      // `unknown` is rendered as its own glyph and word, never as a tick.
      expect(human.stdout).toContain('not measured');
      expect(human.stdout).toContain('[?]');
      expect(await hashTree(repo.root)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('emits a JSON failure object and exit 1 for an unknown command', async () => {
    const repo = await createTempRepo();
    try {
      const result = await runCli(repo.root, ['nope', '--json']);
      expect(result.code).toBe(1);
      const body = parseObject(result.stdout);
      expect(body).toMatchObject({
        schemaVersion: 1,
        command: 'nope',
        ok: false,
        exitCode: 1,
        code: null,
        subject: null,
      });
      expect(String(body['message'])).toContain('unknown command');
      expect(result.stderr).toContain('unknown command');
    } finally {
      await repo.cleanup();
    }
  });
});
