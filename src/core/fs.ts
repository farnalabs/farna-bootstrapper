import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { SOURCE_MAX_BYTES } from './constants.js';
import { invalidConfig, pathUnsafe } from './errors.js';

/**
 * The one place source bytes become text. `readFile(path, 'utf8')` replaces an
 * invalid byte with U+FFFD silently, which would let a mis-encoded persona or
 * an edited config be compiled as though the bytes were what the author meant.
 * Every source read is strict UTF-8 and refused with the byte offset instead.
 */

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NO_BLOCK = constants.O_NONBLOCK ?? 0;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export type ReadBytesOptions = {
  action?: string;
  maxBytes?: number;
};

/**
 * Read a repository-controlled file into bytes, bounded and without following a
 * symlink. The open fd is authoritative: a path swapped for a symlink or a FIFO
 * after the caller's `lstat` is refused rather than followed or blocked on.
 * A file larger than `maxBytes` is a typed refusal naming the repository-relative
 * subject, never an `Invalid string length` from the allocation that would
 * otherwise follow.
 */
export async function readBoundedBytes(
  path: string,
  subject: string,
  options: ReadBytesOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? SOURCE_MAX_BYTES;
  const action = options.action ?? 'make the path readable and re-run';
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW | NO_BLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ELOOP') {
      throw pathUnsafe(`symlink not allowed: ${subject}`, {
        subject,
        action: 'replace the symbolic link with a real file',
      });
    }
    throw invalidConfig(`cannot read ${subject} (${describeFsError(error)})`, {
      subject,
      action,
      cause: error,
    });
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw pathUnsafe(`${subject} is not a regular file`, {
        subject,
        action: 'replace it with a regular file, or remove it',
      });
    }
    if (stats.size > maxBytes) {
      throw pathUnsafe(`${subject} is larger than ${maxBytes} bytes; refusing to read it`, {
        subject,
        action: 'replace it with a file this tool can inspect, then re-run',
      });
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** The first byte offset of an invalid UTF-8 sequence, or `undefined`. */
export function firstInvalidUtf8Offset(bytes: Uint8Array): number | undefined {
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index];
    if (lead === undefined) {
      return index;
    }
    if (lead <= 0x7f) {
      index += 1;
      continue;
    }
    let continuation: number;
    let codepoint: number;
    let minimum: number;
    if (lead >= 0xc2 && lead <= 0xdf) {
      continuation = 1;
      codepoint = lead & 0x1f;
      minimum = 0x80;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      continuation = 2;
      codepoint = lead & 0x0f;
      minimum = 0x800;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      continuation = 3;
      codepoint = lead & 0x07;
      minimum = 0x10000;
    } else {
      return index;
    }
    if (index + continuation >= bytes.length) {
      return index;
    }
    for (let step = 1; step <= continuation; step += 1) {
      const byte = bytes[index + step];
      if (byte === undefined || (byte & 0xc0) !== 0x80) {
        return index + step;
      }
      codepoint = (codepoint << 6) | (byte & 0x3f);
    }
    const surrogate = codepoint >= 0xd800 && codepoint <= 0xdfff;
    if (codepoint < minimum || codepoint > 0x10ffff || surrogate) {
      return index;
    }
    index += continuation + 1;
  }
  return undefined;
}

/** Decode strict UTF-8, naming the subject and the first bad byte offset. */
export function decodeUtf8(bytes: Uint8Array, subject: string): string {
  const invalid = firstInvalidUtf8Offset(bytes);
  if (invalid !== undefined) {
    throw invalidConfig(`${subject} is not valid UTF-8 (byte offset ${invalid})`, {
      subject,
      action: 're-save the file as UTF-8; invalid bytes are refused rather than replaced',
    });
  }
  // `ignoreBOM: true` keeps a leading BOM in the text, so the parsers can
  // refuse it explicitly instead of silently accepting a file that some editors
  // then rewrite differently.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export type ReadUtf8Options = {
  action?: string;
};

/**
 * Read a source file as strict UTF-8. A filesystem failure is a typed error with
 * the repository-relative subject, never a raw `EACCES` carrying an absolute
 * path; the CLI's error boundary has one shape for every failure. The read is
 * bounded before any allocation (see `SOURCE_MAX_BYTES`).
 */
export async function readUtf8File(
  path: string,
  subject: string,
  options: ReadUtf8Options = {},
): Promise<string> {
  const action = options.action ?? 'make the path readable and re-run';
  const bytes = await readBoundedBytes(path, subject, { action, maxBytes: SOURCE_MAX_BYTES });
  return decodeUtf8(bytes, subject);
}

/** A one-line filesystem code, for a message; never the raw absolute path. */
export function describeFsError(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Refuse a path the tool cannot inspect, with the repository-relative subject. */
export function inspectionFailed(subject: string, error: unknown): never {
  throw pathUnsafe(`cannot inspect ${subject}`, {
    subject,
    action: 'make the path readable and re-run, or remove it',
    cause: error,
  });
}
