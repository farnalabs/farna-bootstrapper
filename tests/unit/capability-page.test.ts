import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRODUCT_VERSION, SUPPORTED_TARGETS } from '../../src/core/constants.js';
import { MATRIX_CAPABILITIES, permissionCategories, SNAPSHOT } from '../../src/matrix/snapshot.js';
import { RENDERER_PIN, rendererTargetIds } from '../../src/render/upstream.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'capability-page.mjs');
const PAGE = join(ROOT, 'docs', 'capability-matrix.md');
const PAGE_RELATIVE = 'docs/capability-matrix.md';

function run(
  args: readonly string[],
  cwd = ROOT,
  env: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'farna-capability-page-'));
}

function remove(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function readPage(root: string): string {
  return readFileSync(join(root, PAGE_RELATIVE), 'utf8');
}

/** The ids in the measured-targets table, in page order. */
function measuredIds(page: string): string[] {
  const start = page.indexOf('## Measured targets');
  const end = page.indexOf('\n### ', start);
  return page
    .slice(start, end)
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => (line.split('|')[1] ?? '').trim().replaceAll('`', ''));
}

/** The bullets under "Not measured", in page order. */
function notMeasuredIds(page: string): string[] {
  return page
    .slice(page.indexOf('## Not measured'))
    .split('\n')
    .filter((line) => line.startsWith('- `'))
    .map((line) => line.slice(3).trim().replaceAll('`', ''));
}

describe('the capability page generator', () => {
  let work: string;
  let reportFile: string;
  let rendererIdsFile: string;
  let rendererIds: string[];
  let page: string;

  /** Render the page into the given root from the fixtures, never the repository. */
  function generate(extra: readonly string[], root: string): string {
    const result = run([
      '--root',
      root,
      '--report',
      reportFile,
      '--renderer-targets',
      rendererIdsFile,
      ...extra,
    ]);
    expect(result.status, result.stderr).toBe(0);
    return root;
  }

  beforeAll(async () => {
    work = tempRoot();
    reportFile = join(work, 'report.json');
    writeFileSync(
      reportFile,
      execFileSync(process.execPath, [join(ROOT, 'dist', 'cli', 'main.js'), 'report', '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
      }),
      'utf8',
    );
    rendererIds = await rendererTargetIds();
    rendererIdsFile = join(work, 'renderer-targets.json');
    writeFileSync(rendererIdsFile, JSON.stringify(rendererIds), 'utf8');
    page = readPage(generate([], join(work, 'generated')));
  }, 120_000);

  afterAll(() => {
    remove(work);
  });

  it('generates identical bytes from two builds, with no clock, host or absolute path', () => {
    const FIRST = join(work, 'determinism-a');
    const SECOND = join(work, 'determinism-b');
    const PROBED = join(work, 'determinism-host');
    generate([], FIRST);
    generate([], SECOND);
    const probeHost = 'zzz-probe-host-name';
    const probed = run(
      ['--root', PROBED, '--report', reportFile, '--renderer-targets', rendererIdsFile],
      ROOT,
      { HOSTNAME: probeHost, COMPUTERNAME: probeHost, HOST: probeHost },
    );
    expect(probed.status, probed.stderr).toBe(0);
    try {
      const firstBytes = readFileSync(join(FIRST, PAGE_RELATIVE));
      const secondBytes = readFileSync(join(SECOND, PAGE_RELATIVE));
      const probedBytes = readFileSync(join(PROBED, PAGE_RELATIVE));
      expect(firstBytes.equals(secondBytes)).toBe(true);
      expect(firstBytes.equals(probedBytes)).toBe(true);

      const text = firstBytes.toString('utf8');
      expect(text).not.toContain(probeHost);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(text).not.toContain(ROOT);
      expect(text).not.toContain(tmpdir());
      expect(text.endsWith('\n')).toBe(true);
      expect(text.endsWith('\n\n')).toBe(false);
      expect(text).not.toMatch(/[ \t]+\n/);
      expect(text).toContain(
        `Generated from farna-bootstrapper ${PRODUCT_VERSION} against renderer ${RENDERER_PIN.name} ${RENDERER_PIN.version}, matrix schema version 1.`,
      );
    } finally {
      remove(FIRST);
      remove(SECOND);
      remove(PROBED);
    }
  });

  it('changes only the not-measured list when the renderer id list grows', () => {
    const grownIdsFile = join(work, 'grown-renderer-targets.json');
    writeFileSync(grownIdsFile, JSON.stringify([...rendererIds, 'zzz-synthetic-target']), 'utf8');
    const grownRoot = generate(['--renderer-targets', grownIdsFile], join(work, 'grown'));
    try {
      const grown = readPage(grownRoot);
      const beforeNotMeasured = (text: string): string =>
        text.slice(0, text.indexOf('## Not measured'));
      expect(beforeNotMeasured(grown)).toBe(beforeNotMeasured(page));
      expect(grown).toContain('- `zzz-synthetic-target`');
      expect(page).not.toContain('zzz-synthetic-target');
      const supported = new Set<string>(SUPPORTED_TARGETS);
      expect(notMeasuredIds(grown)).toEqual(
        [...rendererIds, 'zzz-synthetic-target'].filter((id) => !supported.has(id)).sort(),
      );
    } finally {
      remove(grownRoot);
    }
  });

  it('reports the committed page as current', () => {
    const result = run(['--check']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${PAGE_RELATIVE} is current`);
  });

  it('fails --check after a one-byte edit, and never writes the page', () => {
    const root = generate([], join(work, 'stale'));
    try {
      const pagePath = join(root, PAGE_RELATIVE);
      const original = readFileSync(pagePath);
      expect(
        run([
          '--root',
          root,
          '--report',
          reportFile,
          '--renderer-targets',
          rendererIdsFile,
          '--check',
        ]).status,
      ).toBe(0);

      const edited = Buffer.from(original);
      const index = edited.indexOf('Capability matrix');
      expect(index).toBeGreaterThan(-1);
      edited[index] = 'c'.charCodeAt(0);
      writeFileSync(pagePath, edited);

      const result = run([
        '--root',
        root,
        '--report',
        reportFile,
        '--renderer-targets',
        rendererIdsFile,
        '--check',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('capability-matrix.md');
      expect(result.stderr).toContain('stale');
      expect(result.stderr).toContain('first difference at line 1');

      // The gate never repairs the file it rejected, and never touches the
      // committed page.
      expect(readFileSync(pagePath).equals(edited)).toBe(true);
      expect(readFileSync(PAGE).equals(original)).toBe(true);
    } finally {
      remove(root);
    }
  });

  it('has one measured row per supported target, each exactly once', () => {
    expect(measuredIds(page)).toEqual([...SUPPORTED_TARGETS]);
    expect(new Set(measuredIds(page)).size).toBe(measuredIds(page).length);
  });

  it('carries one column per capability in the reported order', () => {
    expect(page).toContain(
      `| Target | Status | Reach | ${MATRIX_CAPABILITIES.join(' | ')} | Evidence |`,
    );
  });

  it('lists exactly the renderer ids that have no measured row', () => {
    const listed = notMeasuredIds(page);
    const supported = new Set<string>(SUPPORTED_TARGETS);
    expect(listed).toEqual(rendererIds.filter((id) => !supported.has(id)).sort());
    for (const measured of SUPPORTED_TARGETS) {
      expect(listed).not.toContain(measured);
    }
    expect(listed.length).toBe(rendererIds.length - SUPPORTED_TARGETS.length);
    expect(page).toContain(`This list names the renderer's ${listed.length} target ids`);
  });

  it('renders the permission vocabulary and never a tick for an unmeasured key', () => {
    // The summary table only: the per-target evidence tables also have rows
    // whose first cell is a target or key name.
    const start = page.indexOf('## Permission keys');
    const lines = page.slice(start, page.indexOf('\n### ', start)).split('\n');
    const headerCells = (lines.find((line) => line.startsWith('| Target |')) ?? '')
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim().replaceAll('`', ''));
    const columnOf = (key: string): number => headerCells.indexOf(key);
    for (const key of permissionCategories()) {
      expect(columnOf(key), key).toBeGreaterThan(0);
    }
    const cellsOf = (id: string): string[] => {
      const row = lines.find((line) => line.startsWith(`| \`${id}\` |`));
      expect(row, id).toBeDefined();
      return (row ?? '')
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
    };
    const claude = cellsOf('claudecode');
    const opencode = cellsOf('opencode');
    const opencodev1 = cellsOf('opencodev1');
    const write = columnOf('write');
    const mcp = columnOf('mcp');
    expect(claude[write]).toBe('[x]');
    expect(opencode[write]).toBe('[~] (W112_PERMISSION_LOSSY)');
    expect(opencodev1[write]).toBe('[~] (W112_PERMISSION_LOSSY)');
    expect(claude[mcp]).toBe('[ ] (F011_PERMISSION_UNMAPPED)');
    expect(opencode[mcp]).toBe('[?] (F011_PERMISSION_UNMAPPED)');
    expect(opencodev1[mcp]).toBe('[?] (F011_PERMISSION_UNMAPPED)');
    expect(page).toContain('[?] not measured');
  });

  it('runs the staleness gate in both CI jobs against the real build', () => {
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const steps = ci
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line === 'run: node scripts/capability-page.mjs --check');
    expect(steps).toHaveLength(2);
  });

  it('names an existing test for every permission key', () => {
    for (const target of SNAPSHOT.targets) {
      for (const key of permissionCategories()) {
        const testId = target.permissionKeys[key].testId;
        expect(testId, `${target.id}/${key}`).toMatch(/^tests\/.+\.test\.ts$/);
        expect(existsSync(join(ROOT, testId)), `${target.id}/${key} -> ${testId}`).toBe(true);
      }
    }
  });
});
