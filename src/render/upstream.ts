import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { generate } from 'rulesync';
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
 * The pinned renderer. The version and integrity the lockfile records are read
 * from the installed package; this constant is the pin they are checked
 * against, so a swapped or patched renderer fails loudly instead of silently
 * producing bytes under the pinned name.
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
  if (identity.integrity !== undefined && identity.integrity !== RENDERER_PIN.integrity) {
    throw rendererMismatch(
      `the installed ${identity.name} has integrity ${identity.integrity} but this build pins ${RENDERER_PIN.integrity ?? 'none'}`,
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
  readonly name: RenderTargetName = 'claudecode';
  private cachedIdentity: RendererIdentity | undefined;

  identity(): RendererIdentity {
    this.cachedIdentity ??= installedRendererIdentity(RENDERER_PIN.name);
    return { ...this.cachedIdentity };
  }

  async generate(request: RenderRequest): Promise<RenderResult> {
    assertPinned(this.identity());
    let result: Awaited<ReturnType<typeof generate>>;
    try {
      result = await generate({
        targets: [request.target],
        // The product derives its own feature set. The wildcard silently skips
        // features a target does not support, so it is never used here.
        features: ['subagents'],
        inputRoots: [request.sourceRoot],
        outputRoots: [request.outputRoot],
        silent: true,
      });
    } catch (error) {
      throw renderFailed('the renderer threw', {
        subject: RENDERER_PIN.name,
        cause: error,
      });
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
