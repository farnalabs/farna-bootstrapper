/**
 * CI gate for the test run.
 *
 * A green `vitest run` can hide five things this gate closes:
 *
 * 1. a test file that was deleted, or silently stopped collecting, so the run
 *    shrank and a whole suite disappeared;
 * 2. a real-renderer suite that did not run (those are the only tests that can
 *    detect a renderer regression);
 * 3. a silently skipped test on the platform CI runs on;
 * 4. a `test.todo`, which is collected and green but asserts nothing; and
 * 5. a report whose totals do not account for the whole run.
 *
 * The set of test files is enumerated from `tests/**`\/*.test.ts, so adding a
 * suite needs no edit here; every discovered file must appear in the report and
 * the report's suite count must cover them. The minimum total stays as a second
 * floor. Raise MIN_TOTAL deliberately when it moves; never lower it to make a
 * red run pass. On Windows the repository has intentional symlink skips, so
 * pending tests are tolerated there; CI runs on Linux and requires zero.
 *
 * Usage: node scripts/assert-test-count.mjs [report] [root]
 * `root` defaults to the current directory; tests pass a fixture root so the
 * gate itself can be exercised without the real repository.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const MIN_TOTAL = 180;

const REAL_RENDERER_SUITES = [
  { suffix: 'tests/integration/rulesync.test.ts', minimum: 4 },
  { suffix: 'tests/golden/builder-python.test.ts', minimum: 2 },
];

const reportPath = process.argv[2] ?? 'vitest-report.json';
const root = process.argv[3] ?? process.cwd();

function enumerateTests(directory) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...enumerateTests(path));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      found.push(relative(root, path).split(sep).join('/'));
    }
  }
  return found.sort();
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`test-count: cannot read ${reportPath}: ${error.message}`);
  process.exit(1);
}

const failures = [];
const todo = typeof report.numTodoTests === 'number' ? report.numTodoTests : 0;
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
// `numPassedTests` must account for the whole run. A report whose totals do not
// add up is a fabricated or truncated report, not a green one.
const accounted =
  (typeof report.numPassedTests === 'number' ? report.numPassedTests : -1) +
  (typeof report.numFailedTests === 'number' ? report.numFailedTests : 0) +
  (typeof report.numPendingTests === 'number' ? report.numPendingTests : 0) +
  todo;
if (accounted !== report.numTotalTests) {
  failures.push(
    `numPassedTests does not account for the total: passed/failed/pending/todo sum to ${accounted}, the report has ${report.numTotalTests}`,
  );
}

if (todo > 0) {
  failures.push(
    `${todo} test(s) are TODO on ${process.platform}; a todo is collected but asserts nothing`,
  );
}

const testResults = Array.isArray(report.testResults) ? report.testResults : [];
const ranSuites = new Set(testResults.map((entry) => String(entry.name).replaceAll('\\', '/')));

// Every test FILE on disk must appear in the report. This is what catches a
// deleted suite: a floor on the total test count cannot see 14 tests leaving
// one file when other files grew, but a missing file is unambiguous.
const testFiles = enumerateTests(join(root, 'tests'));
if (testFiles.length === 0) {
  failures.push('no tests/**/*.test.ts files were found; the test tree is missing');
}
for (const file of testFiles) {
  const ran = [...ranSuites].some((name) => name.endsWith(file));
  if (!ran) {
    failures.push(`test file did not run: ${file}`);
  }
}
if (typeof report.numTotalTestSuites === 'number' && report.numTotalTestSuites < testFiles.length) {
  failures.push(
    `the report covers ${report.numTotalTestSuites} suite(s) but ${testFiles.length} test file(s) exist`,
  );
}

for (const suite of REAL_RENDERER_SUITES) {
  const result = testResults.find((entry) =>
    // Vitest reports the platform path; a Windows checkout spells it with
    // backslashes, which must not make a suite look as though it never ran.
    String(entry.name)
      .replaceAll('\\', '/')
      .endsWith(suite.suffix),
  );
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
  `test-count: ${report.numPassedTests} of ${report.numTotalTests} tests passed in ${testFiles.length} file(s) (minimum ${MIN_TOTAL})${pending}; real-renderer suites ran (${REAL_RENDERER_SUITES.map((suite) => `${suite.suffix}:>=${suite.minimum}`).join(', ')})`,
);
