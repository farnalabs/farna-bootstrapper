/**
 * One process in the generate-lock concurrency test.
 *
 * argv: <repoRoot> <resultFile> <hold|try>
 * - hold: acquire the lock, append `acquired <pid>`, wait for the release file,
 *   then append `released <pid>`.
 * - try: acquire the lock and append `acquired <pid>`, or append
 *   `refused <CODE>` when another process holds it.
 *
 * It imports the BUILT lock module, so the test exercises the shipped code
 * rather than a reimplementation.
 */
import { access, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const { withGenerateLock } = await import(
  new URL('../../dist/render/generate-lock.js', import.meta.url)
);

const [repoRoot, resultFile, mode] = process.argv.slice(2);
const releaseFile = join(repoRoot, 'release');

async function record(line) {
  await appendFile(resultFile, `${line}\n`, 'utf8');
}

try {
  await withGenerateLock(repoRoot, async () => {
    await record(`acquired ${process.pid}`);
    if (mode !== 'hold') {
      return;
    }
    const deadline = Date.now() + 8_000;
    for (;;) {
      try {
        await access(releaseFile);
        break;
      } catch {
        if (Date.now() > deadline) {
          throw new Error('release file never appeared');
        }
        await delay(20);
      }
    }
  });
  if (mode === 'hold') {
    await record(`released ${process.pid}`);
  }
} catch (error) {
  await record(`refused ${error.code ?? error.message}`);
}
