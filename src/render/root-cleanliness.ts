import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isOsMetadataName, OPENCODE_SKILLS_DIR } from '../core/constants.js';
import { compareCodepoints } from '../core/json.js';
import { containedTarget, lstatOrUndefined } from '../core/paths.js';
import type { LockFileEntry } from '../lock/lockfile.js';

/**
 * The design's **root cleanliness** control (`ownership.md` section 9): produce
 * no stale render, and notice one when it is already on disk.
 *
 * The lockfile is the only proof that this tool wrote a path. When it is lost,
 * or when the source stops producing a path so nothing records it any more, a
 * file left in a managed location is indistinguishable from a clue that an older
 * persona is still live. `check` must not call that tree clean, and `generate`
 * must not claim it produced the tree.
 *
 * Only *plausible renders* are reported: a path some declared persona or
 * resource would have produced. A file the user keeps in a managed directory
 * under a name no declaration would ever emit (`custom.md`, `skills/custom/`)
 * is genuinely theirs and stays invisible.
 */

/** A file that exists but is neither planned nor recorded. */
export type StalePath = { path: string; symbolicLink: boolean };

/**
 * Paths in `declared` that exist on disk but are neither in the fresh plan nor
 * recorded in the lockfile. Nothing is deleted.
 */
export async function findStaleRenders(
  repoRoot: string,
  declared: readonly string[],
  planned: ReadonlySet<string>,
  recorded: ReadonlySet<string>,
): Promise<StalePath[]> {
  const stale: StalePath[] = [];
  for (const path of declared) {
    if (planned.has(path) || recorded.has(path)) {
      continue;
    }
    const absolute = await containedTarget(repoRoot, path);
    const stats = await lstatOrUndefined(absolute, path);
    if (stats === undefined) {
      continue;
    }
    stale.push({ path, symbolicLink: stats.isSymbolicLink() });
  }
  return stale.sort((a, b) => compareCodepoints(a.path, b.path));
}

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
