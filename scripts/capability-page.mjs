/**
 * Generate `docs/capability-matrix.md` from the measured report.
 *
 * The page is a pure function of three inputs, each read from a built artefact
 * rather than typed here:
 *
 * 1. the measured rows, from the built CLI's own `report --json` output. Running
 *    the command means the snapshot passed `verifySnapshot` before a byte of the
 *    page was written, and it means the page and the command can never disagree;
 * 2. the renderer's target ids, through the single renderer importer in
 *    `src/render/upstream.ts`. This script never imports `rulesync` itself, so
 *    the one-importer rule in CONTRIBUTING holds;
 * 3. the product version, from the built `dist/core/constants.js`.
 *
 * There is no clock, host name or absolute path in the output: a timestamp
 * would make the bytes differ on every run and the staleness gate could never be
 * green. The page answers "what produced this" with a provenance line, and the
 * CI gate answers "when" by refusing a page that no longer matches the build.
 *
 * Usage:
 *   node scripts/capability-page.mjs                 # write the page
 *   node scripts/capability-page.mjs --check         # exit 1 when it is stale
 *
 * Test-only inputs, so a fixture can drive the generator without a built CLI:
 *   --report <path>            read the report JSON from a file
 *   --renderer-targets <path>  read a JSON array of renderer ids from a file
 *   --root <path>              the repository root (where `docs/` lives)
 *
 * The CI gate passes none of the test-only inputs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE_PATH = join('docs', 'capability-matrix.md');
const REGENERATE = 'node scripts/capability-page.mjs';

function fail(message) {
  console.error(`capability-page: ${message}`);
  process.exit(1);
}

function parseArguments(argv) {
  const options = { check: false, report: undefined, rendererTargets: undefined, root: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    const valued = {
      '--report': 'report',
      '--renderer-targets': 'rendererTargets',
      '--root': 'root',
    };
    const key = valued[argument];
    if (key !== undefined) {
      const value = argv[index + 1];
      if (value === undefined) {
        fail(`${argument} needs a path`);
      }
      options[key] = value;
      index += 1;
      continue;
    }
    fail(`unknown argument "${argument}"`);
  }
  return options;
}

async function loadBuildModules() {
  try {
    const [constants, snapshot, upstream] = await Promise.all([
      import(new URL('../dist/core/constants.js', import.meta.url).href),
      import(new URL('../dist/matrix/snapshot.js', import.meta.url).href),
      import(new URL('../dist/render/upstream.js', import.meta.url).href),
    ]);
    return { constants, snapshot, upstream };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`the build is missing or unreadable (${reason}); run: npm run build`);
  }
}

function readReport(options, root) {
  if (options.report !== undefined) {
    return JSON.parse(readFileSync(resolve(options.report), 'utf8'));
  }
  const cli = join(root, 'dist', 'cli', 'main.js');
  if (!existsSync(cli)) {
    fail(`the built CLI is missing at ${relative(process.cwd(), cli) || cli}; run: npm run build`);
  }
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [cli, 'report', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error.stderr === undefined ? '' : String(error.stderr).trim();
    fail(`the report command failed${stderr === '' ? '' : `: ${stderr}`}`);
  }
  return JSON.parse(stdout);
}

async function readRendererTargetIds(options, upstream) {
  if (options.rendererTargets !== undefined) {
    const parsed = JSON.parse(readFileSync(resolve(options.rendererTargets), 'utf8'));
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
      fail(`${options.rendererTargets} must hold a JSON array of target-id strings`);
    }
    return parsed;
  }
  return await upstream.rendererTargetIds();
}

/** Codepoint order, so the published order never inherits the upstream order. */
function compareCodepoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function glyphOf(snapshot, emission) {
  return snapshot.emissionGlyph(emission);
}

function wordOf(snapshot, emission) {
  return snapshot.emissionWord(emission);
}

/** A Markdown table cell from authored text: no pipes, no newlines. */
function cell(text) {
  return text.replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ').trim();
}

function code(value) {
  return `\`${cell(value)}\``;
}

function distinct(values) {
  return [...new Set(values)].sort(compareCodepoints);
}

function evidenceList(testIds) {
  const ids = distinct(testIds.filter((id) => typeof id === 'string' && id !== ''));
  return ids.length === 0 ? '-' : ids.map(code).join(', ');
}

function matrixSection(report, snapshot) {
  const capabilities = snapshot.MATRIX_CAPABILITIES;
  const lines = ['## Measured targets', ''];
  lines.push(
    `| Target | Status | Reach | ${capabilities.join(' | ')} | Evidence |`,
    `|---|---|---|${capabilities.map(() => '---').join('|')}|---|`,
  );
  for (const target of report.targets) {
    const cells = capabilities.map((capability) => {
      const measured = target.capabilities[capability];
      return `${glyphOf(snapshot, measured.agent)} / ${glyphOf(snapshot, measured.workspace)}`;
    });
    const testIds = capabilities.map((capability) => target.capabilities[capability].testId);
    lines.push(
      `| ${code(target.id)} | ${target.status} | ${target.agentReach} | ${cells.join(' | ')} | ${evidenceList(testIds)} |`,
    );
  }
  lines.push(
    '',
    "Each capability cell reads `agent / workspace`: whether the capability can land in one persona's",
    'artefact, and whether it can land at the workspace level where every persona sees it.',
    '',
  );

  for (const target of report.targets) {
    lines.push(`### ${code(target.id)}`, '');
    lines.push(
      '| Capability | agent | workspace | basis | Test | Consequence |',
      '|---|---|---|---|---|---|',
    );
    for (const capability of capabilities) {
      const measured = target.capabilities[capability];
      lines.push(
        `| ${[
          code(capability),
          `${glyphOf(snapshot, measured.agent)} ${wordOf(snapshot, measured.agent)}`,
          `${glyphOf(snapshot, measured.workspace)} ${wordOf(snapshot, measured.workspace)}`,
          measured.basis,
          measured.testId === null ? '-' : code(measured.testId),
          measured.consequence === null ? '-' : cell(measured.consequence),
        ].join(' | ')} |`,
      );
    }
    lines.push('');
  }
  return lines;
}

function permissionSection(report, snapshot) {
  const keys = snapshot.permissionCategories();
  const lines = ['## Permission keys', '', 'Per persona, agent mode.', ''];
  lines.push(
    `| Target | ${keys.map((key) => code(key)).join(' | ')} |`,
    `|---|${keys.map(() => '---').join('|')}|`,
  );
  for (const target of report.targets) {
    const cells = keys.map((key) => {
      const measured = target.permissionKeys[key];
      const diagnostic = measured.code === null ? '' : ` (${measured.code})`;
      return `${glyphOf(snapshot, measured.emission)}${diagnostic}`;
    });
    lines.push(`| ${code(target.id)} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  for (const target of report.targets) {
    lines.push(`### ${code(target.id)}`, '');
    lines.push('| Key | Emission | Code | Test | Consequence |', '|---|---|---|---|---|');
    for (const key of keys) {
      const measured = target.permissionKeys[key];
      lines.push(
        `| ${[
          code(key),
          `${glyphOf(snapshot, measured.emission)} ${wordOf(snapshot, measured.emission)}`,
          measured.code === null ? '-' : code(measured.code),
          code(measured.testId),
          measured.consequence === null ? '-' : cell(measured.consequence),
        ].join(' | ')} |`,
      );
    }
    lines.push('');
  }
  return lines;
}

function buildPage({ report, rendererTargetIds, productName, productVersion, snapshot }) {
  const measuredIds = report.targets.map((target) => target.id);
  const notMeasured = distinct(rendererTargetIds).filter((id) => !measuredIds.includes(id));

  const lines = [
    '# Capability matrix',
    '',
    'This page is generated from the committed capability snapshot by',
    `\`${REGENERATE}\`. It states what this build emits and verifies for each measured`,
    'target, not what a harness does at runtime.',
    '',
    'Evidence basis: every measured cell names the test that observes it. `basis` is',
    '`emitted` for a golden test that pins the emitted bytes and `probe` for a planner test that',
    'proves a refusal. The harness remains the authority on runtime behaviour.',
    '',
    '`unknown` is never a tick. A cell marked `[?]` was not measured, and an id in the not-measured',
    'list below carries no capability claim at all.',
    '',
    `Generated from ${productName} ${productVersion} against renderer ${report.renderer.name} ${report.renderer.version}, matrix schema version ${report.schemaVersion}.`,
    '',
    '## Emissions',
    '',
    '| Value | Glyph | Meaning |',
    '|---|---|---|',
    '| native | `[x]` | the harness carries the capability in its own form |',
    '| emulated | `[~]` | the capability is carried by a different mechanism, or with a widening |',
    '| dropped | `[ ]` | the capability is not carried; the consequence names the refusal or warning |',
    '| not measured | `[?]` | the capability was never measured, so it is never presented as a tick |',
    '',
    "Each cell has two axes: `agent` (one persona's artefact) and `workspace` (visible to every",
    'persona).',
    '',
    ...matrixSection(report, snapshot),
    ...permissionSection(report, snapshot),
    '## Evidence',
    '',
    'The test ids above are repository-relative paths. A cell is edited only in the same change',
    'that moves the test observing it, so a cell with no test would be a claim nobody measured.',
    'Every id above is listed in `scripts/expected-test-files.json`. The page cannot state a claim',
    'that `report` does not print, and CI runs',
    `\`${REGENERATE} --check\` so a stale page cannot merge.`,
    '',
    '## Not measured',
    '',
    `This list names the renderer's ${notMeasured.length} target ids that have no measured row, out of the`,
    `${distinct(rendererTargetIds).length} ids the pinned renderer accepts. It makes no capability claim: the`,
    'renderer accepting an id is not evidence that this build renders, verifies or describes',
    'anything for it. One harness can have several ids (for example `opencode` and `opencodev1`),',
    'so this is a count of ids, not a count of harnesses.',
    '',
    ...notMeasured.map((id) => `- ${code(id)}`),
    '',
    '---',
    '',
    `Regenerate this page with \`npm run build\` and \`${REGENERATE}\`. CI runs`,
    `\`${REGENERATE} --check\` and fails when the committed page is stale.`,
    '',
  ];
  return lines.join('\n');
}

function firstDifference(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const total = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < total; index += 1) {
    const left = expectedLines[index];
    const right = actualLines[index];
    if (left !== right) {
      return {
        line: index + 1,
        expected: left ?? '(end of file)',
        actual: right ?? '(end of file)',
      };
    }
  }
  return undefined;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = resolve(options.root ?? fileURLToPath(new URL('..', import.meta.url)));
  const modules = await loadBuildModules();
  const report = readReport(options, root);
  const rendererIds = await readRendererTargetIds(options, modules.upstream);
  const page = buildPage({
    report,
    rendererTargetIds: rendererIds,
    productName: modules.constants.PRODUCT_NAME,
    productVersion: modules.constants.PRODUCT_VERSION,
    snapshot: modules.snapshot,
  });
  const pagePath = join(root, PAGE_PATH);
  const displayed = relative(process.cwd(), pagePath) || pagePath;

  if (options.check) {
    if (!existsSync(pagePath)) {
      fail(`${displayed} is missing; run: ${REGENERATE}`);
    }
    const committed = readFileSync(pagePath, 'utf8');
    if (committed === page) {
      console.log(`capability-page: ${displayed} is current`);
      return;
    }
    const difference = firstDifference(page, committed);
    console.error(`capability-page: ${displayed} is stale`);
    if (difference !== undefined) {
      console.error(`  first difference at line ${difference.line}`);
      console.error(`  expected: ${difference.expected}`);
      console.error(`  actual:   ${difference.actual}`);
    }
    fail(`run: ${REGENERATE}`);
  }

  mkdirSync(dirname(pagePath), { recursive: true });
  writeFileSync(pagePath, page, 'utf8');
  console.log(`capability-page: wrote ${displayed}`);
}

await main();
