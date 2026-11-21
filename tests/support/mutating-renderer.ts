import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  RendererIdentity,
  RenderRequest,
  RenderResult,
  RenderTarget,
} from '../../src/render/port.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';

/**
 * A renderer that produces the real, pinned output and then lets a test change
 * it. This is how the containment gates are proven to fire on shapes only the
 * real renderer emits: the baseline is the renderer's own bytes, so the only
 * difference is the one the test introduces.
 */
export type Mutation = (
  request: RenderRequest,
  result: RenderResult,
) => Promise<RenderResult> | RenderResult;

export class MutatingRenderTarget implements RenderTarget {
  private readonly inner = new UpstreamRenderTarget();

  constructor(private readonly mutate: Mutation) {}

  identity(): RendererIdentity {
    return this.inner.identity();
  }

  recordedIdentity(): RendererIdentity {
    return this.inner.recordedIdentity?.() ?? this.inner.identity();
  }

  async generate(request: RenderRequest): Promise<RenderResult> {
    const result = await this.inner.generate(request);
    return await this.mutate(request, result);
  }
}

export async function readOutput(outputRoot: string, path: string): Promise<string> {
  return await readFile(join(outputRoot, path), 'utf8');
}

export async function writeOutput(
  outputRoot: string,
  path: string,
  contents: string,
): Promise<void> {
  await writeFile(join(outputRoot, path), contents, 'utf8');
}
