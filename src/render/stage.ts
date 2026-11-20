import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathUnsafe } from '../core/errors.js';

export type Stage = {
  /** Canonical path to the stage root. */
  root: string;
  /** `root/src` — the rulesync source tree. */
  sourceRoot: string;
  /** `root/out` — the renderer output root. */
  outputRoot: string;
};

async function canonicalTmpRoot(): Promise<string> {
  // Canonicalise once: on macOS /var is a symlink to /private/var.
  return realpath(tmpdir());
}

function assertInside(root: string, candidate: string): void {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (candidate !== root && !candidate.startsWith(prefix)) {
    throw pathUnsafe('refusing to remove a path outside the temporary root', {
      subject: candidate,
    });
  }
}

/**
 * Create a disposable stage and always remove it. The stage is the only place
 * a renderer is allowed to write before verification passes.
 */
export async function withStage<T>(run: (stage: Stage) => Promise<T>): Promise<T> {
  const tmpRoot = await canonicalTmpRoot();
  const created = await mkdtemp(join(tmpRoot, 'farna-bootstrapper-'));
  const root = await realpath(created);
  const sourceRoot = join(root, 'src');
  const outputRoot = join(root, 'out');
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  try {
    return await run({ root, sourceRoot, outputRoot });
  } finally {
    // Remove the directory this function created, after proving it is inside
    // the canonical temporary root. This is the one recursive delete in src/,
    // and it can only ever target a mkdtemp directory we own.
    assertInside(tmpRoot, root);
    await rm(root, { recursive: true, force: true });
  }
}
