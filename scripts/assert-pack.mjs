/**
 * CI gate for the published package.
 *
 * `dist/` is gitignored, so a tarball built from a clean clone silently ships
 * four files and no `bin` target unless something builds it. `prepack` is that
 * something; this gate proves the tarball contains the entry points AND that it
 * was `prepack` that produced them.
 *
 * It does not trust a `dist/` already on disk: the directory is renamed aside
 * before `npm pack`, so a missing `prepack` fails here even when CI ran a build
 * in an earlier step. The original directory is restored afterwards.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const DIST = 'dist';
const STASH = 'dist.farna-pack-gate';
const REQUIRED = ['dist/cli/main.js', 'dist/index.js', 'dist/index.d.ts', 'package.json'];

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
  });
} catch (error) {
  failure = `npm pack failed: ${error.message}`;
} finally {
  // Discard whatever `prepack` produced and put the caller's build back.
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
  console.error('  - a tarball with no dist means `prepack` did not run or did not build');
  process.exit(1);
}

console.log(`pack: ${files.length} files, entry points present (${REQUIRED.join(', ')})`);
