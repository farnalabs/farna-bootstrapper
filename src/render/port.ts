import type { DEFAULT_TARGET } from '../core/constants.js';

/**
 * The injection seam. Everything above this module works against
 * `RenderTarget`; exactly one module implements it using the real renderer.
 * No renderer type crosses this boundary.
 */

export type RenderTargetName = typeof DEFAULT_TARGET;

export type RenderRequest = {
  target: RenderTargetName;
  /**
   * Absolute path to the disposable stage. A renderer that reads its own
   * configuration must read it from inside this directory, so an ambient file
   * in the working directory cannot change the run.
   */
  stageRoot: string;
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
   * The tarball integrity npm recorded for the installed package. An installed
   * package that records none has `undefined` here and is refused (F010), never
   * silently skipped; the version is always read from the installed package,
   * never from a compiled-in literal.
   */
  integrity?: string | undefined;
};

export interface RenderTarget {
  readonly name: RenderTargetName;
  /** The identity of the renderer actually loaded, used to verify the pin. */
  identity(): RendererIdentity;
  /**
   * The identity recorded in the lockfile. A pinned renderer records the pin so
   * the lockfile is identical on every machine with the same source; it defaults
   * to `identity()` for a renderer with no separate pin.
   */
  recordedIdentity?(): RendererIdentity;
  generate(request: RenderRequest): Promise<RenderResult>;
}
