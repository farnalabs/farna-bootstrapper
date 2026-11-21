/**
 * The injection seam. Everything above this module works against
 * `RenderTarget`; exactly one module implements it using the real renderer.
 * No renderer type crosses this boundary.
 */

export type RenderTargetName = 'claudecode';

export type RenderRequest = {
  target: RenderTargetName;
  /** Absolute path to the rulesync-shaped source tree (`subagents/`, ...). */
  sourceRoot: string;
  /** Absolute path to an empty directory the renderer writes into. */
  outputRoot: string;
};

export type RenderResult = {
  target: RenderTargetName;
  /** Emitted file paths, relative to `outputRoot`, sorted by codepoint. */
  files: string[];
  /** True when the renderer could not read at least one source file. */
  sourceLoadFailed: boolean;
};

export type RendererIdentity = {
  name: string;
  version: string;
  /**
   * The tarball integrity npm recorded for the installed package. Omitted only
   * when the package manager did not record one; the version is always read
   * from the installed package, never from a compiled-in literal.
   */
  integrity?: string;
};

export interface RenderTarget {
  readonly name: RenderTargetName;
  identity(): RendererIdentity;
  generate(request: RenderRequest): Promise<RenderResult>;
}
