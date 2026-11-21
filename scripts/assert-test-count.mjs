/**
 * CI gate for the test run.
 *
 * Two things are asserted, both of which a green `vitest run` can hide:
 *
 * 1. the exact number of tests, so a silently skipped or uncollected suite
 *    fails the gate rather than shrinking the run; and
 * 2. that the two real-renderer suites executed, with their expected counts.
 *    Those are the only tests that can detect a renderer regression, and they
 *    used to be wrapped in a probe that could never engage.
 *
 * Update EXPECTED_TOTAL deliberately when tests are added or removed.
 */
import { readFileSync } from 'node:fs';

const EXPECTED_TOTAL = 110;

const REAL_RENDERER_SUITES = [
  { suffix: 'tests/integration/rulesync.test.ts', tests: 3 },
  { suffix: 'tests/golden/builder-python.test.ts', tests: 2 },
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
if (report.numTotalTests !== EXPECTED_TOTAL) {
  failures.push(
    `expected ${EXPECTED_TOTAL} tests, the report has ${report.numTotalTests}; a suite was added, removed or did not collect`,
  );
}
if (report.numFailedTests > 0) {
  failures.push(`${report.numFailedTests} test(s) failed`);
}
if (report.numPendingTests > 0) {
  failures.push(`${report.numPendingTests} test(s) are pending; a silent skip is not a pass`);
}

const testResults = Array.isArray(report.testResults) ? report.testResults : [];
for (const suite of REAL_RENDERER_SUITES) {
  const result = testResults.find((entry) => String(entry.name).endsWith(suite.suffix));
  if (result === undefined) {
    failures.push(`real-renderer suite did not run: ${suite.suffix}`);
    continue;
  }
  const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
  if (assertions.length !== suite.tests) {
    failures.push(
      `${suite.suffix}: expected ${suite.tests} tests, the report has ${assertions.length}`,
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

console.log(
  `test-count: ${report.numTotalTests} tests passed; real-renderer suites ran (${REAL_RENDERER_SUITES.map((suite) => `${suite.suffix}:${suite.tests}`).join(', ')})`,
);
