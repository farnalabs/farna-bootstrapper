import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../scripts/assert-test-count.mjs', import.meta.url));

type Report = {
  numTotalTests: number;
  numTotalTestSuites?: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  testResults: Array<{ name: string; assertionResults: Array<{ status: string }> }>;
};

function passed(count: number): Array<{ status: string }> {
  return Array.from({ length: count }, () => ({ status: 'passed' }));
}

function report(overrides: Partial<Report> = {}): Report {
  const base: Report = {
    numTotalTests: 200,
    numPassedTests: 200,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      { name: '/repo/tests/integration/rulesync.test.ts', assertionResults: passed(4) },
      { name: '/repo/tests/golden/builder-python.test.ts', assertionResults: passed(2) },
    ],
  };
  return { ...base, ...overrides };
}

const DEFAULT_FILES = ['tests/integration/rulesync.test.ts', 'tests/golden/builder-python.test.ts'];

/**
 * Run the gate against a fixture root. The gate enumerates `tests/**` and reads
 * `scripts/expected-test-files.json` from that root, so the test controls both
 * what exists on disk and what the manifest expects, independently of the
 * report it is handed.
 */
async function runGate(
  value: Report,
  files: readonly string[] = DEFAULT_FILES,
  manifestFiles: readonly string[] | null = files,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'fbs-gate-'));
  try {
    for (const file of files) {
      const absolute = join(dir, file);
      await mkdir(join(absolute, '..'), { recursive: true });
      await writeFile(absolute, '', 'utf8');
    }
    if (manifestFiles !== null) {
      const manifestPath = join(dir, 'scripts', 'expected-test-files.json');
      await mkdir(join(dir, 'scripts'), { recursive: true });
      await writeFile(manifestPath, JSON.stringify({ files: manifestFiles }), 'utf8');
    }
    const path = join(dir, 'vitest-report.json');
    await writeFile(path, JSON.stringify(value), 'utf8');
    try {
      const result = await execFileAsync(process.execPath, [SCRIPT, path, dir], {
        timeout: 30_000,
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('the test-count gate', () => {
  it('passes a fabricated report whose totals add up', async () => {
    const result = await runGate(report());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('of 200 tests passed');
  });

  it('fails on a test.todo, which is collected but asserts nothing', async () => {
    const result = await runGate(report({ numTodoTests: 1, numPassedTests: 199 }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('TODO');
  });

  it('fails when numPassedTests does not account for the total', async () => {
    const result = await runGate(report({ numPassedTests: 150 }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('does not account for the total');
  });

  it('matches a real-renderer suite on a Windows-shaped path', async () => {
    const result = await runGate(
      report({
        testResults: [
          { name: 'C:\\repo\\tests\\integration\\rulesync.test.ts', assertionResults: passed(4) },
          { name: 'C:\\repo\\tests\\golden\\builder-python.test.ts', assertionResults: passed(2) },
        ],
      }),
    );
    expect(result.code).toBe(0);
  });

  it('fails when a real-renderer suite did not run', async () => {
    const result = await runGate(
      report({
        testResults: [
          { name: '/repo/tests/integration/rulesync.test.ts', assertionResults: passed(4) },
        ],
      }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('real-renderer suite did not run');
  });

  it('fails below the minimum floor', async () => {
    const result = await runGate(report({ numTotalTests: 5, numPassedTests: 5 }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('expected at least');
  });

  it('fails when a test file exists on disk but is absent from the report', async () => {
    const result = await runGate(report(), [
      'tests/integration/rulesync.test.ts',
      'tests/golden/builder-python.test.ts',
      'tests/unit/deleted-suite.test.ts',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('test file did not run: tests/unit/deleted-suite.test.ts');
  });

  it('passes when a new suite is added together with its manifest entry', async () => {
    const result = await runGate(
      report({
        testResults: [
          { name: '/repo/tests/integration/rulesync.test.ts', assertionResults: passed(4) },
          { name: '/repo/tests/golden/builder-python.test.ts', assertionResults: passed(2) },
          { name: '/repo/tests/unit/new-suite.test.ts', assertionResults: passed(5) },
        ],
      }),
      [
        'tests/integration/rulesync.test.ts',
        'tests/golden/builder-python.test.ts',
        'tests/unit/new-suite.test.ts',
      ],
    );
    expect(result.code).toBe(0);
  });

  it('fails when a suite is deleted while it remains in the manifest', async () => {
    // The exact gap that a disk-only enumeration could not see: the file leaves
    // disk AND the report, and the remaining tests still clear the floor, so
    // only the manifest can report the missing suite.
    const result = await runGate(report(), DEFAULT_FILES, [
      ...DEFAULT_FILES,
      'tests/unit/permissions.test.ts',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'the test-file manifest lists tests/unit/permissions.test.ts, which is missing from disk',
    );
  });

  it('fails when a test file exists on disk but is not in the manifest', async () => {
    const result = await runGate(report(), DEFAULT_FILES, DEFAULT_FILES.slice(0, 1));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'test file is not listed in scripts/expected-test-files.json: tests/golden/builder-python.test.ts',
    );
  });

  it('fails when a manifest entry did not run', async () => {
    const result = await runGate(
      report({
        testResults: [
          { name: '/repo/tests/integration/rulesync.test.ts', assertionResults: passed(4) },
        ],
      }),
      DEFAULT_FILES,
      DEFAULT_FILES,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'manifest test file did not run: tests/golden/builder-python.test.ts',
    );
  });

  it('fails when the manifest cannot be read', async () => {
    // Falling back to the disk set would reintroduce the deleted-suite gap, so
    // a missing manifest is a failure, not a default.
    const result = await runGate(report(), DEFAULT_FILES, null);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cannot read the test-file manifest');
  });

  it('fails when the manifest lists the same file twice', async () => {
    const result = await runGate(report(), DEFAULT_FILES, [
      ...DEFAULT_FILES,
      'tests/integration/rulesync.test.ts',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('the test-file manifest lists duplicates');
  });

  it('fails when the report suite count does not cover the files on disk', async () => {
    const result = await runGate(
      report({
        numTotalTestSuites: 1,
        testResults: [
          { name: '/repo/tests/integration/rulesync.test.ts', assertionResults: passed(4) },
          { name: '/repo/tests/golden/builder-python.test.ts', assertionResults: passed(2) },
        ],
      }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('test file(s) exist');
  });
});
