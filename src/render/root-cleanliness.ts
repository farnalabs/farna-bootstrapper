import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isOsMetadataName, OPENCODE_SKILLS_DIR } from '../core/constants.js';
import { compareCodepoints } from '../core/json.js';
import { containedTarget, lstatOrUndefined } from '../core/paths.js';
import type { LockFileEntry } from '../lock/lockfile.js';
import { isStagingName } from './staging.js';

/**
 * The one unrecorded path `check` reports: an extra file inside a **skill
 * directory this tool owns**.
 *
 * The lockfile is the only proof that this tool wrote a regular path. A skill
 * directory is different: it is a tree this tool owns as a whole, so a file
 * inside a recorded or planned skill directory that neither the plan nor the
 * lockfile names was not produced by a generate, and it would otherwise sit
 * inside our own directory forever. It is reported (W107) and never deleted.
 *
 * Nothing here scans for "plausible prior renders" by name. With no lockfile
 * there is no record of what this tool wrote, so `generate` refuses and asks for
 * `--adopt` rather than guessing from a file path; a stale output not recorded
 * and not in the plan is the user's responsibility.
 */

/** A file that exists but is neither planned nor recorded. */
export type StalePath = { path: string; symbolicLink: boolean };

/** The skill directories a run has a reason to inspect: one per declared skill id. */
function skillDirectories(paths: Iterable<string>): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(`${OPENCODE_SKILLS_DIR}/`)) {
      continue;
    }
    const id = path.split('/')[2];
    if (id !== undefined && id !== '') {
      directories.add(`${OPENCODE_SKILLS_DIR}/${id}`);
    }
  }
  return [...directories].sort(compareCodepoints);
}

async function walk(
  repoRoot: string,
  directory: string,
  planned: ReadonlySet<string>,
  recorded: ReadonlySet<string>,
  found: StalePath[],
): Promise<void> {
  const absolute = await containedTarget(repoRoot, directory);
  const stats = await lstatOrUndefined(absolute, directory);
  if (stats === undefined) {
    return;
  }
  if (stats.isSymbolicLink()) {
    found.push({ path: directory, symbolicLink: true });
    return;
  }
  if (!stats.isDirectory()) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => compareCodepoints(a.name, b.name))) {
    if (isOsMetadataName(entry.name)) {
      continue;
    }
    // A staging sibling is this tool's own temporary file, not an extra: a
    // concurrent or killed generate can leave one, and reporting it would make
    // `check` red for our own in-flight write.
    if (isStagingName(entry.name)) {
      continue;
    }
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(repoRoot, path, planned, recorded, found);
      continue;
    }
    if (planned.has(path) || recorded.has(path)) {
      continue;
    }
    // A symbolic link is reported, never followed.
    found.push({ path, symbolicLink: entry.isSymbolicLink() });
  }
}

/**
 * A skill directory is a tree this tool owns, so a file inside a **recorded or
 * planned** skill directory that neither the plan nor the lockfile names is an
 * extra: it was not produced by a generate, and it would otherwise sit inside
 * our own directory forever. It is reported (W107) and never deleted.
 */
export async function findSkillTreeExtras(
  repoRoot: string,
  planned: ReadonlySet<string>,
  recorded: readonly LockFileEntry[],
): Promise<StalePath[]> {
  const recordedPaths = new Set(recorded.map((entry) => entry.path));
  const found: StalePath[] = [];
  const candidates = [...planned, ...recordedPaths];
  for (const directory of skillDirectories(candidates)) {
    await walk(repoRoot, directory, planned, recordedPaths, found);
  }
  return found.sort((a, b) => compareCodepoints(a.path, b.path));
}
