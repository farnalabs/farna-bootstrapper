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
 * Two gates running at once therefore never share a stash: each moves the same
 * `dist/` aside only once, and the second sees no `dist/` to move.
 *
 * The tarball is checked against an ALLOWLIST, not a list of forbidden names.
 * Every path must be under `dist/` or be one of the legal root files. A new
 * path therefore fails closed: widening `files` (or replacing the allowlist
 * with a denylist) cannot quietly publish a repository file, because anything
 * not named here is refused. Source maps are refused explicitly: the published
 * build emits none, and a `.map` with its sources stripped is a dangling
 * reference rather than a debugging aid.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const DIST = 'dist';
const STASH = `${DIST}.farna-pack-gate-${process.pid}-${randomUUID()}`;
/**
 * One gate at a time per working tree. The stash name is already unique, but
 * two gates in the same directory would still race on `dist/`: the first moves
 * it aside, the second sees none and both `prepack` builds write the same
 * directory. The lock is an exclusive created file; a stale one (a killed run)
 * is reclaimed after the age bound.
 */
const LOCK = `${DIST}.farna-pack-gate.lock`;
const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_WAIT_MS = 300_000;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

let lockHeld = false;

function acquireLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(LOCK, 'wx'));
      lockHeld = true;
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        console.error(`pack: cannot create ${LOCK} (${error.code ?? 'unknown error'})`);
        process.exit(1);
      }
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(LOCK);
          continue;
        }
      } catch {
        // The holder released it between the failed create and this stat.
        continue;
      }
      if (Date.now() > deadline) {
        console.error(`pack: another assert-pack is still running (${LOCK})`);
        process.exit(1);
      }
      sleep(100);
    }
  }
}

acquireLock();
process.on('exit', () => {
  if (!lockHeld) {
    // Never remove a lock another run holds.
    return;
  }
  try {
    unlinkSync(LOCK);
  } catch {
    // Already gone: another process reclaimed a lock this run no longer holds.
  }
});
const REQUIRED = [
  'dist/cli/main.js',
  'dist/index.js',
  'dist/index.d.ts',
  'package.json',
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
];
/** The only root files a published package may carry. */
const ALLOWED_ROOT_FILES = new Set([
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE',
  'SECURITY.md',
]);
/** The only directory a published package may carry files from. */
const ALLOWED_DIRECTORY = `${DIST}/`;

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

// An allowlist, so an unexpected path can never be published by accident. The
// message keeps the phrase "repository-only path" because that is what such a
// file is: a checkout artefact that reached the registry.
const leaked = files.filter(
  (path) => !ALLOWED_ROOT_FILES.has(path) && !path.startsWith(ALLOWED_DIRECTORY),
);
if (leaked.length > 0) {
  console.error('pack: FAILED');
  for (const path of leaked) {
    console.error(`  - repository-only path in the tarball: ${path}`);
  }
  console.error(
    '  - the tarball allowlist is dist/ plus package.json, README.md, CHANGELOG.md, LICENSE, NOTICE and SECURITY.md',
  );
  process.exit(1);
}

// The published build emits no source or declaration maps. A map without its
// `sourcesContent` is a dangling reference to files the package does not ship.
const maps = files.filter((path) => path.endsWith('.map'));
if (maps.length > 0) {
  console.error('pack: FAILED');
  for (const path of maps) {
    console.error(`  - source map in the tarball: ${path}`);
  }
  console.error(
    '  - disable `sourceMap` and `declarationMap` in the published build, or inline the sources',
  );
  process.exit(1);
}

console.log(`pack: ${files.length} files, entry points and legal files present`);
