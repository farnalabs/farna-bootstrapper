import type { SupportedTarget } from '../core/constants.js';

/**
 * The injection seam. Everything above this module works against
 * `RenderTarget`; exactly one module implements it using the real renderer.
 * No renderer type crosses this boundary.
 */

export type RenderTargetName = SupportedTarget;

/**
 * A target id the renderer accepts in its `targets` option. It is deliberately
 * not `SupportedTarget`: the renderer knowing how to write some artefacts for a
 * harness says nothing about whether this build can plan, verify or describe
 * them. Only a `SupportedTarget` is ever passed to a render.
 */
export type RendererTargetId = string;

/** The renderer features this product can select. Never the `*` wildcard. */
export type RenderFeature =
  | 'rules'
  | 'ignore'
  | 'mcp'
  | 'subagents'
  | 'commands'
  | 'skills'
  | 'hooks'
  | 'permissions'
  | 'checks';

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
  /**
   * The rulesync features this render needs. The product derives its own set
   * from the materialised source rather than passing `*`, because the wildcard
   * silently skips a feature the target does not support. Omitted means
   * `['subagents']`, which is the whole set a Claude Code agent-mode render
   * needs.
   */
  features?: readonly RenderFeature[];
};

export type RenderResult = {
  target: RenderTargetName;
  /** Emitted file paths, relative to `outputRoot`, sorted by codepoint. */
  files: string[];
  /** True when the renderer could not read at least one source file. */
  sourceLoadFailed: boolean;
};

/**
 * The outcome of looking for the installed renderer's integrity in the two
 * supported npm lock records at the install root.
 *
 * The renderer identity policy is:
 *
 * - the installed **version** must equal `RENDERER_PIN.version`; a mismatch is
 *   `F010_RENDERER_MISMATCH` (exit 5);
 * - when a lock record supplies a string integrity, it must equal
 *   `RENDERER_PIN.integrity`; a mismatch is also `F010`;
 * - when neither supported record holds a renderer entry
 *   (`reason: 'no-record'`) or the entry has no string integrity
 *   (`reason: 'no-integrity'`), the version check still applies, the run
 *   continues, and `W114_RENDERER_INTEGRITY_UNVERIFIED` names what could not be
 *   checked. A layout outside those two records is not read and yields `W114`.
 *
 * Only a genuinely absent entry, or an entry without a string integrity, is
 * `W114`. A present-but-unreadable, symlinked, non-regular or over-size lock
 * record remains a refusal (`F010`): an integrity that exists but cannot be
 * read must fail exactly like one that differs.
 */
export type RecordedIntegrity =
  | { verified: true; integrity: string; reason?: undefined }
  | { verified: false; integrity?: undefined; reason: 'no-record' | 'no-integrity' };

export type RendererIdentity = {
  name: string;
  version: string;
  /**
   * The tarball integrity npm recorded for the installed package, when one was
   * found. `undefined` means no supported lock record supplied a string
   * integrity; the version check still runs and `W114` reports the gap. The
   * version is always read from the installed package, never from a
   * compiled-in literal.
   */
  integrity?: string | undefined;
  /**
   * How `integrity` was established. The real target sets this from npm's lock
   * records; an injected target may omit it, in which case a present
   * `integrity` is treated as verified and an absent one as no record.
   */
  integrityRecord?: RecordedIntegrity | undefined;
};

export interface RenderTarget {
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
