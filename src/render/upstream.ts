import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { DEFAULT_TARGET } from '../core/constants.js';
import { rendererMismatch, renderFailed } from '../core/errors.js';
import { compareCodepoints } from '../core/json.js';
import { installedRendererIdentity } from './identity.js';
import type {
  RendererIdentity,
  RenderRequest,
  RenderResult,
  RenderTarget,
  RenderTargetName,
} from './port.js';

/**
 * The pinned renderer. This constant is BOTH the identity recorded in the
 * lockfile and the pin the installed package is checked against: recording the
 * installed integrity instead made the lockfile differ per machine (one with
 * `node_modules/.package-lock.json`, one without) and `check` reported false
 * drift. A renderer whose version or npm-recorded tarball integrity differs
 * fails loudly. A global install records no npm integrity at all; in that one
 * case the compiled-in pin stands in for it (the version is still checked),
 * because otherwise every `npm i -g` install failed F010 on every command.
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
 * The identity an installed package is checked against. A global install has no
 * npm lock record, so the compile-time pin stands in for the missing integrity
 * only when the version matches. The pin is provenance, not a sandbox.
 *
 * @internal Exported so a test can prove the fallback without a global install;
 * `UpstreamRenderTarget.identity()` is the production caller.
 */
export function resolvePinnedIdentity(installed: RendererIdentity): RendererIdentity {
  return installed.integrity === undefined && installed.version === RENDERER_PIN.version
    ? { ...installed, integrity: RENDERER_PIN.integrity }
    : installed;
}

/**
 * Refuse a renderer that is not the pinned one. The version check runs first, so
 * a substituted pin can never make a different install pass.
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
  // A global install has no npm record. The compiled-in pin is the only
  // integrity available there, and it is still compared against the one this
  // build expects; the version check above is what catches a different install.
  const integrity = identity.integrity ?? RENDERER_PIN.integrity;
  if (integrity !== RENDERER_PIN.integrity) {
    throw rendererMismatch(
      `the installed ${identity.name} has integrity ${integrity} but this build pins ${RENDERER_PIN.integrity}`,
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
  readonly name: RenderTargetName = DEFAULT_TARGET;
  private cachedIdentity: RendererIdentity | undefined;

  identity(): RendererIdentity {
    if (this.cachedIdentity === undefined) {
      this.cachedIdentity = resolvePinnedIdentity(installedRendererIdentity(RENDERER_PIN.name));
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
        features: ['subagents'],
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
