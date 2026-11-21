import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { generate } from 'rulesync';
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
 * fails loudly, and a missing installed integrity fails rather than skipping
 * the check.
 *
 * The renderer is imported in-process. The pin is provenance, not a sandbox:
 * file-content tampering inside an installed package (a `patch-package` entry,
 * an edited `dist`) keeps the same version and integrity and is NOT detected;
 * see the README's residual list.
 */
export const RENDERER_PIN: RendererIdentity = {
  name: 'rulesync',
  version: '43.11.0',
  integrity:
    'sha512-P9YtvLVkUsSAfdU2zvh2CFGkikTT3/frT5dajHU+S1YoYxsd+NHF9sjN2f7jSWAbKMXKRWBLw75g4vobCClZYQ==',
};

function assertPinned(identity: RendererIdentity): void {
  if (identity.version !== RENDERER_PIN.version) {
    throw rendererMismatch(
      `the installed ${identity.name} is ${identity.version} but this build pins ${RENDERER_PIN.version}`,
      {
        subject: identity.name,
        action: 're-install dependencies from the lockfile, or upgrade farna-bootstrapper',
      },
    );
  }
  if (identity.integrity === undefined) {
    throw rendererMismatch(
      `the installed ${identity.name} package records no tarball integrity, so it cannot be checked against this build's pin`,
      {
        subject: identity.name,
        action:
          're-install dependencies with npm so node_modules/.package-lock.json records the integrity; the check is never skipped',
      },
    );
  }
  if (identity.integrity !== RENDERER_PIN.integrity) {
    throw rendererMismatch(
      `the installed ${identity.name} has integrity ${identity.integrity} but this build pins ${RENDERER_PIN.integrity}`,
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
 */
export class UpstreamRenderTarget implements RenderTarget {
  readonly name: RenderTargetName = DEFAULT_TARGET;
  private cachedIdentity: RendererIdentity | undefined;

  identity(): RendererIdentity {
    this.cachedIdentity ??= installedRendererIdentity(RENDERER_PIN.name);
    return { ...this.cachedIdentity };
  }

  /** The pin, never the installed integrity: the lockfile is machine-independent. */
  recordedIdentity(): RendererIdentity {
    return { ...RENDERER_PIN };
  }

  async generate(request: RenderRequest): Promise<RenderResult> {
    assertPinned(this.identity());
    let result: Awaited<ReturnType<typeof generate>>;
    // rulesync resolves its config against the working directory and refuses an
    // absolute `configPath` (it treats one as traversal). The stage must be the
    // working directory for the call, so no ambient `rulesync.jsonc` (or
    // `rulesync.local.jsonc`) can flip `dryRun`, `delete` or `check`. The
    // process-wide chdir is restored in `finally`; a renderer call is the only
    // code running at this point.
    const previousCwd = process.cwd();
    try {
      process.chdir(request.stageRoot);
      result = await generate({
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
