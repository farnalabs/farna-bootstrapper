import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../scripts/assert-test-count.mjs', import.meta.url));

type Report = {
  numTotalTests: number;
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

async function runGate(value: Report): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'fbs-gate-'));
  try {
    const path = join(dir, 'vitest-report.json');
    await writeFile(path, JSON.stringify(value), 'utf8');
    try {
      const result = await execFileAsync(process.execPath, [SCRIPT, path], { timeout: 30_000 });
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
});
