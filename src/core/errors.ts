import { type ErrorCode, EXIT_BY_CODE } from './constants.js';

export type FarnaErrorOptions = {
  subject?: string;
  action?: string;
  cause?: unknown;
};

/**
 * A typed failure. The code selects the exit status; the message is assembled
 * from the record, never by concatenation at a call site.
 */
export class FarnaError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly subject?: string;
  readonly action?: string;

  constructor(code: ErrorCode, message: string, options: FarnaErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FarnaError';
    this.code = code;
    this.exitCode = EXIT_BY_CODE[code];
    if (options.subject !== undefined) {
      this.subject = options.subject;
    }
    if (options.action !== undefined) {
      this.action = options.action;
    }
  }

  /** The one-line form the text reporter prints. */
  format(): string {
    const subject = this.subject === undefined ? '' : ` ${this.subject}`;
    const action = this.action === undefined ? '' : `\n  ${this.action}`;
    return `${this.code}${subject}\n  ${this.message}${action}`;
  }
}

export function invalidConfig(message: string, options: FarnaErrorOptions = {}): FarnaError {
  return new FarnaError('F001_INVALID_CONFIG', message, options);
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
