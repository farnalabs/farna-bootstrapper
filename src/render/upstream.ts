import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { rendererMismatch, renderFailed } from '../core/errors.js';
import { compareCodepoints } from '../core/json.js';
import { installedRendererIdentity, integrityRecordOf } from './identity.js';
import type { RendererIdentity, RenderRequest, RenderResult, RenderTarget } from './port.js';

/**
 * The pinned renderer. This constant is BOTH the identity recorded in the
 * lockfile and the pin the installed package is checked against: recording the
 * installed integrity instead made the lockfile differ per machine (one with
 * `node_modules/.package-lock.json`, one without) and `check` reported false
 * drift. The renderer identity policy is: the installed version must match the
 * pin (F010 on a mismatch); an npm-recorded integrity, when one is found, must
 * match the pin (also F010); and when no record supplies a string integrity the
 * version check still applies, the run continues, and
 * `W114_RENDERER_INTEGRITY_UNVERIFIED` names the gap. The pin is never
 * substituted for a missing integrity: that was the silent pass this policy
 * removes.
 *
 * The renderer is imported lazily, inside `generate`. A static import made a
 * missing or broken renderer a raw module-resolution stack before any command
 * could run, including `--version` and `init`, which never render.
 *
 * The pin is provenance, not a sandbox: file-content tampering inside an
 * installed package (a `patch-package` entry, an edited `dist`) keeps the same
 * version and integrity and is NOT detected; see the README's residual list.
 */
export const RENDERER_PIN: RendererIdentity = {
  name: 'rulesync',
  version: '43.11.0',
  integrity:
    'sha512-P9YtvLVkUsSAfdU2zvh2CFGkikTT3/frT5dajHU+S1YoYxsd+NHF9sjN2f7jSWAbKMXKRWBLw75g4vobCClZYQ==',
};

/**
 * The renderer module, loaded once. `typeof import` is a type-only reference,
 * so this file can be imported (for the pin, or for `--version`) without the
 * renderer being installed.
 */
type RendererModule = typeof import('rulesync');

let loaded: RendererModule | undefined;

async function loadRenderer(): Promise<RendererModule> {
  if (loaded !== undefined) {
    return loaded;
  }
  try {
    loaded = await import('rulesync');
    return loaded;
  } catch (error) {
    throw renderFailed(`the pinned renderer ${RENDERER_PIN.name} could not be loaded`, {
      subject: RENDERER_PIN.name,
      action: 're-install dependencies so the pinned renderer is present',
      cause: error,
    });
  }
}

/**
 * Refuse a renderer that is not the pinned one. The version check runs first,
 * so a missing integrity can never let a different version pass.
 *
 * The integrity is compared only when npm recorded one. Substituting the pin
 * for a missing integrity made a global install look verified, which is the
 * silent pass `W114` replaces; an unverified integrity is reported by
 * `prepareRender`, never treated as a match.
 *
 * @internal Exported so a test can prove both outcomes; `render` is the
 * production caller.
 */
export function assertPinned(identity: RendererIdentity): void {
  if (identity.version !== RENDERER_PIN.version) {
    throw rendererMismatch(
      `the installed ${identity.name} is ${identity.version} but this build pins ${RENDERER_PIN.version}`,
      {
        subject: identity.name,
        action: 're-install dependencies from the lockfile, or upgrade farna-bootstrapper',
      },
    );
  }
  const record = integrityRecordOf(identity);
  if (record.verified && record.integrity !== RENDERER_PIN.integrity) {
    throw rendererMismatch(
      `the installed ${identity.name} has integrity ${record.integrity} but this build pins ${RENDERER_PIN.integrity}`,
      {
        subject: identity.name,
        action: 're-install dependencies from the lockfile; a replaced renderer is refused',
      },
    );
  }
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(root, absolute)));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).split(sep).join('/'));
    }
  }
  return files.sort(compareCodepoints);
}

/**
 * The only module that imports rulesync. It performs one generate call and
 * maps the result. It contains no product logic: no path policy, no
 * containment, no writing into the repository.
 *
 * `generate` changes the process working directory (the renderer resolves its
 * config against it), so calls are serialised: two renders in one process would
 * otherwise race on one cwd. `--version` and `init` never call it, and never
 * load the renderer at all.
 */
export class UpstreamRenderTarget implements RenderTarget {
  private cachedIdentity: RendererIdentity | undefined;

  identity(): RendererIdentity {
    if (this.cachedIdentity === undefined) {
      this.cachedIdentity = installedRendererIdentity(RENDERER_PIN.name);
    }
    return { ...this.cachedIdentity };
  }

  /** The pin, never the installed integrity: the lockfile is machine-independent. */
  recordedIdentity(): RendererIdentity {
    return { ...RENDERER_PIN };
  }

  async generate(request: RenderRequest): Promise<RenderResult> {
    return await withRenderLock(async () => await this.render(request));
  }

  private async render(request: RenderRequest): Promise<RenderResult> {
    assertPinned(this.identity());
    const renderer = await loadRenderer();
    let result: Awaited<ReturnType<RendererModule['generate']>>;
    // rulesync resolves its config against the working directory and refuses an
    // absolute `configPath` (it treats one as traversal). The stage must be the
    // working directory for the call, so no ambient `rulesync.jsonc` (or
    // `rulesync.local.jsonc`) can flip `dryRun`, `delete` or `check`. The
    // process-wide chdir is restored in `finally`; the render lock makes that
    // safe for a second render in the same process.
    const previousCwd = process.cwd();
    try {
      process.chdir(request.stageRoot);
      result = await renderer.generate({
        targets: [request.target],
        // The product derives its own feature set. The wildcard silently skips
        // features a target does not support, so it is never used here.
        features: [...(request.features ?? ['subagents'])],
        inputRoots: [request.sourceRoot],
        outputRoots: [request.outputRoot],
        // Hermetic: the renderer's own config is read from the stage (a path
        // that does not exist yields an empty config), never from the caller's
        // working directory, and the three options an ambient rulesync.jsonc
        // could flip are pinned explicitly.
        configPath: 'rulesync.jsonc',
        delete: false,
        dryRun: false,
        check: false,
        silent: true,
      });
    } catch (error) {
      throw renderFailed('the renderer threw', {
        subject: RENDERER_PIN.name,
        cause: error,
      });
    } finally {
      process.chdir(previousCwd);
    }
    if (result.sourceLoadFailed) {
      throw renderFailed('the renderer could not read a source file', {
        subject: RENDERER_PIN.name,
      });
    }
    return {
      target: request.target,
      // Walk the output root: the renderer's own path lists only the files it
      // wrote on this run, so they are empty when nothing changed.
      files: await walk(request.outputRoot),
      sourceLoadFailed: result.sourceLoadFailed,
    };
  }
}

/**
 * Serialise renders in one process. The lock is a promise chain, so a failed
 * render releases it for the next caller and never poisons the queue.
 */
let renderQueue: Promise<unknown> = Promise.resolve();

/** @internal Serialise renders; exported so a test can prove it is a lock. */
export function withRenderLock<T>(run: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(run, run);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
