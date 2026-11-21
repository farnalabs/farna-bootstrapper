/**
 * CI gate for the test run.
 *
 * A green `vitest run` can hide three things this gate closes:
 *
 * 1. a suite that silently stopped collecting, so the run shrank;
 * 2. a real-renderer suite that did not run (those are the only tests that can
 *    detect a renderer regression); and
 * 3. a silently skipped test on the platform CI runs on.
 *
 * It asserts a minimum, not an exact total, so adding coverage is a one-file
 * change. Raise MIN_TOTAL deliberately when the floor moves; never lower it to
 * make a red run pass. On Windows the repository has intentional symlink
 * skips, so pending tests are tolerated there; CI runs on Linux and requires
 * zero.
 */
import { readFileSync } from 'node:fs';

const MIN_TOTAL = 127;

const REAL_RENDERER_SUITES = [
  { suffix: 'tests/integration/rulesync.test.ts', minimum: 4 },
  { suffix: 'tests/golden/builder-python.test.ts', minimum: 2 },
];

const reportPath = process.argv[2] ?? 'vitest-report.json';

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`test-count: cannot read ${reportPath}: ${error.message}`);
  process.exit(1);
}

const failures = [];
if (typeof report.numTotalTests !== 'number' || report.numTotalTests < MIN_TOTAL) {
  failures.push(
    `expected at least ${MIN_TOTAL} tests, the report has ${report.numTotalTests}; a suite was removed or did not collect`,
  );
}
if (report.numFailedTests > 0) {
  failures.push(`${report.numFailedTests} test(s) failed`);
}
if (process.platform !== 'win32' && report.numPendingTests > 0) {
  failures.push(
    `${report.numPendingTests} test(s) are pending on ${process.platform}; a silent skip is not a pass`,
  );
}

const testResults = Array.isArray(report.testResults) ? report.testResults : [];
for (const suite of REAL_RENDERER_SUITES) {
  const result = testResults.find((entry) => String(entry.name).endsWith(suite.suffix));
  if (result === undefined) {
    failures.push(`real-renderer suite did not run: ${suite.suffix}`);
    continue;
  }
  const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
  if (assertions.length < suite.minimum) {
    failures.push(
      `${suite.suffix}: expected at least ${suite.minimum} tests, the report has ${assertions.length}`,
    );
  }
  const notPassed = assertions.filter((assertion) => assertion.status !== 'passed');
  if (notPassed.length > 0) {
    failures.push(`${suite.suffix}: ${notPassed.length} test(s) did not pass`);
  }
}

if (failures.length > 0) {
  console.error('test-count: FAILED');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

const pending =
  report.numPendingTests > 0
    ? ` (${report.numPendingTests} platform skip(s), tolerated on Windows)`
    : '';
console.log(
  `test-count: ${report.numTotalTests} tests passed (minimum ${MIN_TOTAL})${pending}; real-renderer suites ran (${REAL_RENDERER_SUITES.map((suite) => `${suite.suffix}:>=${suite.minimum}`).join(', ')})`,
);
