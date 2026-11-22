/**
 * CI gate for the published package.
 *
 * `dist/` is gitignored, so a tarball built from a clean clone silently ships
 * no `bin` target unless something builds it. `prepack` is that something; this
 * gate proves the tarball contains the entry points AND the legal files, and
 * that it was `prepack` that produced the entry points.
 *
 * It does not trust a `dist/` already on disk: the directory is renamed aside
 * before `npm pack`, so a missing `prepack` fails here even when CI ran a build
 * in an earlier step. The original directory is restored afterwards.
 *
 * The stash name is unique per run. A fixed name made a crashed earlier run
 * leave a directory behind, and the next `renameSync` then threw an uncaught
 * `ENOTEMPTY`; a unique name can never collide, and the restore is idempotent.
 *
 * The gate also refuses a tarball that carries repository-only paths. `files`
 * is an allowlist, so a source, test, workflow or tooling file reaching the
 * package means the allowlist was widened (or replaced with a denylist) and the
 * published package now ships the repository rather than the product.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const DIST = 'dist';
const STASH = `${DIST}.farna-pack-gate-${process.pid}-${randomUUID()}`;
const REQUIRED = [
  'dist/cli/main.js',
  'dist/index.js',
  'dist/index.d.ts',
  'package.json',
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE',
  'README.md',
];
/** Repository-only trees. A published package must not contain any of them. */
const FORBIDDEN_DIRECTORIES = ['src/', 'tests/', 'scripts/', 'examples/', 'docs/', '.github/'];
/** Repository-only files. The tarball is the product, not the checkout. */
const FORBIDDEN_FILES = [
  'biome.json',
  'package-lock.json',
  'tsconfig.build.json',
  'tsconfig.json',
  'vitest-report.json',
  'vitest.config.ts',
];

// Move any existing build out of the way, so only `prepack` can satisfy the
// gate. `npm pack` runs `prepack` even with `--dry-run`.
const hadDist = existsSync(DIST);
if (hadDist) {
  renameSync(DIST, STASH);
}

let raw;
let failure;
try {
  raw = execFileSync(NPM, ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    // `prepack` builds TypeScript; a hung npm must fail the gate, not wedge CI.
    timeout: 300_000,
  });
} catch (error) {
  failure = `npm pack failed: ${error.message}`;
} finally {
  // Discard whatever `prepack` produced and put the caller's build back. The
  // stash is this run's own directory, so a stale one from a killed run is
  // never touched.
  if (existsSync(DIST)) {
    rmSync(DIST, { recursive: true, force: true });
  }
  if (hadDist && existsSync(STASH)) {
    renameSync(STASH, DIST);
  }
}

if (failure !== undefined) {
  console.error(`pack: ${failure}`);
  process.exit(1);
}

let entries;
try {
  entries = JSON.parse(raw);
} catch {
  console.error('pack: npm pack did not return JSON');
  process.exit(1);
}

const entry = Array.isArray(entries) ? entries[0] : undefined;
const files = Array.isArray(entry?.files) ? entry.files.map((file) => file.path) : [];

const missing = REQUIRED.filter((path) => !files.includes(path));
if (missing.length > 0) {
  console.error('pack: FAILED');
  for (const path of missing) {
    console.error(`  - missing from the tarball: ${path}`);
  }
  console.error(
    '  - a tarball with no dist means `prepack` did not run or did not build; a missing legal file means `files` is incomplete',
  );
  process.exit(1);
}

const leaked = files.filter(
  (path) =>
    FORBIDDEN_DIRECTORIES.some((directory) => path.startsWith(directory)) ||
    FORBIDDEN_FILES.includes(path),
);
if (leaked.length > 0) {
  console.error('pack: FAILED');
  for (const path of leaked) {
    console.error(`  - repository-only path in the tarball: ${path}`);
  }
  console.error(
    '  - `files` must stay an allowlist: the published package is dist plus the legal files',
  );
  process.exit(1);
}

console.log(`pack: ${files.length} files, entry points and legal files present`);
