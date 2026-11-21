/**
 * CI gate for the published package.
 *
 * `dist/` is gitignored, so a tarball built from a clean clone silently ships
 * four files and no `bin` target unless something builds it. `prepack` runs the
 * build; this gate proves the result actually contains the entry points.
 */
import { execFileSync } from 'node:child_process';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const REQUIRED = ['dist/cli/main.js', 'dist/index.js', 'dist/index.d.ts', 'package.json'];

let raw;
try {
  raw = execFileSync(NPM, ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
} catch (error) {
  console.error(`pack: npm pack failed: ${error.message}`);
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
  process.exit(1);
}

console.log(`pack: ${files.length} files, entry points present (${REQUIRED.join(', ')})`);
