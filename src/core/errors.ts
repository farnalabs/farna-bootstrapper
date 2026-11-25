import { type DiagnosticCode, DRIFT_CODE, EXIT, EXIT_BY_CODE } from './constants.js';
import { escapeControlCharacters } from './text.js';

export type FarnaErrorOptions = {
  subject?: string;
  action?: string;
  /**
   * Structured guidance printed under the action as an indented block. It is the
   * one field allowed to span lines: a block to paste into a file belongs here,
   * never inside the single-line message.
   */
  detail?: string;
  cause?: unknown;
};

/**
 * A typed failure. The code selects the exit status; the message is assembled
 * from the record, never by concatenation at a call site.
 */
export class FarnaError extends Error {
  readonly code: DiagnosticCode;
  readonly exitCode: number;
  readonly subject?: string;
  readonly action?: string;
  readonly detail?: string;

  constructor(code: DiagnosticCode, message: string, options: FarnaErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FarnaError';
    this.code = code;
    this.exitCode = code === DRIFT_CODE ? EXIT.drift : EXIT_BY_CODE[code];
    if (options.subject !== undefined) {
      this.subject = options.subject;
    }
    if (options.action !== undefined) {
      this.action = options.action;
    }
    if (options.detail !== undefined) {
      this.detail = options.detail;
    }
  }

  /**
   * The diagnostic as text. The subject, the message and the action are each a
   * single line, all escaped: each can embed a source filename, a lockfile path
   * or a foreign key from a hand-edited document, and a raw control character
   * would rewrite the terminal lines the diagnostic appears on. A detail is
   * printed as one indented line per line of the block — its newlines are
   * structure, so they are preserved, but a control character *inside* a line is
   * escaped like every other field. One trailing newline is dropped for the
   * human surface, so a block that ends with one prints no trailing indent-only
   * line; the stored detail and the JSON field keep the block byte for byte.
   */
  format(): string {
    const subject = this.subject === undefined ? '' : ` ${escapeControlCharacters(this.subject)}`;
    const action = this.action === undefined ? '' : `\n  ${escapeControlCharacters(this.action)}`;
    const line = `${this.code}${subject}\n  ${escapeControlCharacters(this.message)}${action}`;
    if (this.detail === undefined) {
      return line;
    }
    const block = this.detail.endsWith('\n') ? this.detail.slice(0, -1) : this.detail;
    const detail = block
      .split('\n')
      .map((detailLine) => `  ${escapeControlCharacters(detailLine)}`)
      .join('\n');
    return `${line}\n${detail}`;
  }
}

export function invalidConfig(message: string, options: FarnaErrorOptions = {}): FarnaError {
  return new FarnaError('F001_INVALID_CONFIG', message, options);
}

/**
 * `generate` refuses to overwrite a managed path it cannot prove it owns. The
 * code is F007 (drift, exit 1), never F008: the path is not a renderer loss, it
 * is a file this tool did not write.
 */
export function driftRefused(message: string, options: FarnaErrorOptions = {}): FarnaError {
  return new FarnaError(DRIFT_CODE, message, options);
}

/** A literal value in a credential position. The message never echoes it. */
export function secretLiteral(message: string, options: FarnaErrorOptions = {}): FarnaError {
  return new FarnaError('F002_SECRET_LITERAL', message, options);
}

export function pathUnsafe(message: string, options: FarnaErrorOptions = {}): FarnaError {
  return new FarnaError('F003_PATH_UNSAFE', message, options);
}

export function conflict(message: string, options: FarnaErrorOptions = {}): FarnaError {
  return new FarnaError('F005_CONFLICT', message, options);
}

export function declaredNotEmitted(message: string, options: FarnaErrorOptions = {}): FarnaError {
  return new FarnaError('F008_DECLARED_NOT_EMITTED', message, options);
}

export function renderFailed(message: string, options: FarnaErrorOptions = {}): FarnaError {
  return new FarnaError('F009_RENDER_FAILED', message, options);
}

export function rendererMismatch(message: string, options: FarnaErrorOptions = {}): FarnaError {
  return new FarnaError('F010_RENDERER_MISMATCH', message, options);
}

export function permissionUnmapped(message: string, options: FarnaErrorOptions = {}): FarnaError {
  return new FarnaError('F011_PERMISSION_UNMAPPED', message, options);
}

/**
 * The verified managed set could not be written. The tree is left as it was;
 * the subject names the path that could not be staged.
 */
export function writeFailed(message: string, options: FarnaErrorOptions = {}): FarnaError {
  return new FarnaError('F012_WRITE_FAILED', message, options);
}
