import {
  ID_MAX_LENGTH,
  ID_RE,
  REGION_BEGIN_WORD,
  REGION_END_WORD,
  REGION_MARKER_PREFIX,
  REGION_MARKER_SUFFIX,
  REGION_OUTPUTS,
} from '../core/constants.js';
import { driftRefused, type FarnaError, invalidConfig } from '../core/errors.js';
import { decodeUtf8 } from '../core/fs.js';

/**
 * A managed region is a marked part of a **text** file this tool owns, delimited
 * by two HTML comment lines:
 *
 * ```text
 * <!-- farna:begin <region-id> -->
 * ...the owned body, replaced as bytes and never parsed or re-wrapped...
 * <!-- farna:end <region-id> -->
 * ```
 *
 * The lockfile records the digest of the body between the markers, never of the
 * whole file: every byte outside the region belongs to the user, so editing it
 * is not drift and a `generate` never rewrites it. The marker lines themselves
 * are owned by the tool: a missing, duplicated, nested or mismatched marker is a
 * typed refusal naming the line, never something this module repairs, because a
 * repair would have to guess which bytes were the tool's.
 *
 * Every function here is pure over text (or bytes and a subject), so the
 * grammar, the body range and the merge are unit-testable without a repository.
 */

const BOM = '\uFEFF';

/** The begin marker line of a region. */
export function regionBeginMarker(regionId: string): string {
  return `${REGION_MARKER_PREFIX}${REGION_BEGIN_WORD} ${regionId}${REGION_MARKER_SUFFIX}`;
}

/** The end marker line of a region. */
export function regionEndMarker(regionId: string): string {
  return `${REGION_MARKER_PREFIX}${REGION_END_WORD} ${regionId}${REGION_MARKER_SUFFIX}`;
}

/** The region id this build owns at a managed path, or `undefined` for a whole file. */
export function regionIdOf(path: string): string | undefined {
  return REGION_OUTPUTS[path];
}

/**
 * The key a recorded-set comparison uses. A path alone no longer identifies a
 * recorded file when two disjoint regions can share one path, so a region entry
 * is keyed by its path and its id; every other shape is keyed by its path.
 * `lockfileTargetOf` deliberately stays path-based: one file has one owning
 * target.
 */
export function regionEntryKey(path: string, regionId: string): string {
  return `${path}#region:${regionId}`;
}

/** The marker pair, the body and the end marker's newline, ready to append or create. */
export function regionBlock(regionId: string, body: string): string {
  return `${regionBeginMarker(regionId)}\n${normaliseRegionBody(body)}${regionEndMarker(regionId)}\n`;
}

/**
 * The body exactly as it is written between the marker lines. The end marker
 * must begin its own line, so a rendered body that does not end in a newline
 * gains exactly one. An empty body stays empty: the two marker lines are then
 * adjacent. Any other byte of the body is preserved: the body is replaced as
 * bytes, never reformatted.
 */
export function normaliseRegionBody(body: string): string {
  return body === '' || body.endsWith('\n') ? body : `${body}\n`;
}

/** A line of the scanned text, with the offsets the body range is built from. */
type Line = {
  number: number;
  content: string;
  /** Offset of the line's first character. */
  start: number;
  /** Offset just past the line's terminator, or `text.length` for the last line. */
  next: number;
};

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let number = 1;
  for (;;) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      if (start < text.length) {
        lines.push({ number, content: text.slice(start), start, next: text.length });
      }
      return lines;
    }
    lines.push({ number, content: text.slice(start, newline), start, next: newline + 1 });
    start = newline + 1;
    number += 1;
    if (start === text.length) {
      return lines;
    }
  }
}

/**
 * A region body is replaced in place, so a CRLF file cannot be rewritten
 * without changing bytes outside the region. It is refused instead, naming the
 * first line that ends in CR.
 */
function assertLfLineEndings(text: string, subject: string): void {
  const carriage = text.indexOf('\r');
  if (carriage === -1) {
    return;
  }
  const line = text.slice(0, carriage).split('\n').length;
  throw invalidConfig(`${subject} line ${line} ends in CR`, {
    subject,
    action: 'convert the file to LF, or add the .gitattributes entry and re-check it out',
  });
}

type Marker = { kind: 'begin' | 'end'; id: string };

/**
 * Parse one line as a marker. The line's content must equal the production
 * exactly, so a leading space, a trailing space, a doubled separator or an id
 * outside the grammar all return `undefined` and are reported by the caller.
 */
function parseMarkerLine(content: string): Marker | undefined {
  if (!content.startsWith(REGION_MARKER_PREFIX) || !content.endsWith(REGION_MARKER_SUFFIX)) {
    return undefined;
  }
  const inner = content.slice(
    REGION_MARKER_PREFIX.length,
    content.length - REGION_MARKER_SUFFIX.length,
  );
  const separator = inner.indexOf(' ');
  if (separator === -1) {
    return undefined;
  }
  const kind = inner.slice(0, separator);
  const id = inner.slice(separator + 1);
  if (kind !== REGION_BEGIN_WORD && kind !== REGION_END_WORD) {
    return undefined;
  }
  if (id.length > ID_MAX_LENGTH || !ID_RE.test(id)) {
    return undefined;
  }
  return { kind, id };
}

/** One well-formed, disjoint region and the offsets of its three parts. */
export type RegionSpan = {
  id: string;
  /** The 1-based line of the begin marker. */
  beginLine: number;
  /** The 1-based line of the end marker. */
  endLine: number;
  /** Offset of the begin marker line's first character. */
  start: number;
  /** Offset just past the end marker line's terminator. */
  end: number;
  /** Offset of the first body character. */
  bodyStart: number;
  /** Offset of the end marker line's first character. */
  bodyEnd: number;
};

export type ParsedRegionFile = {
  /** The byte-order mark the file carried, or `''`. Re-attached on every write. */
  bom: string;
  /** The file text without the BOM. Every offset in `regions` is into this string. */
  text: string;
  /** Every well-formed region, in document order. */
  regions: RegionSpan[];
};

function nestedRegion(
  subject: string,
  marker: Marker,
  line: number,
  openId: string,
  openLine: number,
): FarnaError {
  return invalidConfig(
    `${subject} line ${line} begins region "${marker.id}" inside the body of region "${openId}" begun on line ${openLine}`,
    {
      subject,
      action: 'remove the nested region; a region body may not contain another region',
    },
  );
}

function duplicateRegion(
  subject: string,
  marker: Marker,
  line: number,
  firstLine: number,
): FarnaError {
  return invalidConfig(
    `${subject} line ${line} begins region "${marker.id}" again; the id already appears on line ${firstLine}`,
    {
      subject,
      action: 'remove one of the regions; a region id may appear once in a file',
    },
  );
}

function unmatchedEnd(subject: string, marker: Marker, line: number): FarnaError {
  return invalidConfig(
    `${subject} line ${line} ends region "${marker.id}" without a matching begin marker`,
    {
      subject,
      action: 'remove the end marker, or add the matching begin marker before it',
    },
  );
}

function mismatchedEnd(
  subject: string,
  marker: Marker,
  line: number,
  openId: string,
  openLine: number,
): FarnaError {
  return invalidConfig(
    `${subject} line ${line} ends region "${marker.id}" but the open region is "${openId}" begun on line ${openLine}`,
    {
      subject,
      action: 'make the end marker name the open region, or remove one of the pair',
    },
  );
}

function unmatchedBegin(subject: string, id: string, line: number): FarnaError {
  return invalidConfig(
    `${subject} line ${line} begins region "${id}" without a matching end marker`,
    {
      subject,
      action: 'add the matching end marker after the region body, or remove the begin marker',
    },
  );
}

function malformedMarker(subject: string, line: number): FarnaError {
  return invalidConfig(`${subject} line ${line} is not a valid region marker`, {
    subject,
    action: `make the line read ${regionBeginMarker('<region-id>')} or ${regionEndMarker('<region-id>')} exactly, or move the file aside`,
  });
}

/**
 * Parse a region file. The grammar is section 5 of the design note:
 *
 * ```text
 * marker     = "<!-- farna:" ("begin" | "end") " " region-id " -->"
 * region-id  = /^[a-z0-9]+(?:-[a-z0-9]+)*$/   (at most 64 characters)
 * ```
 *
 * A marker is a complete line, LF-terminated or last in the file; a line that
 * contains the marker prefix but does not match is a typed refusal naming its
 * 1-based line. A begin must have exactly one matching end of the same id, in
 * order, with no other begin between them. A leading BOM is split off and every
 * offset is into the text after it.
 */
export function parseRegionText(source: string, subject: string): ParsedRegionFile {
  const bom = source.startsWith(BOM) ? BOM : '';
  const text = bom === '' ? source : source.slice(1);
  assertLfLineEndings(text, subject);
  const regions: RegionSpan[] = [];
  let open: { id: string; beginLine: number; beginStart: number; bodyStart: number } | undefined;
  for (const line of splitLines(text)) {
    if (!line.content.includes(REGION_MARKER_PREFIX)) {
      continue;
    }
    const marker = parseMarkerLine(line.content);
    if (marker === undefined) {
      throw malformedMarker(subject, line.number);
    }
    if (marker.kind === 'begin') {
      if (open !== undefined) {
        throw nestedRegion(subject, marker, line.number, open.id, open.beginLine);
      }
      const duplicate = regions.find((region) => region.id === marker.id);
      if (duplicate !== undefined) {
        throw duplicateRegion(subject, marker, line.number, duplicate.beginLine);
      }
      open = {
        id: marker.id,
        beginLine: line.number,
        beginStart: line.start,
        bodyStart: line.next,
      };
      continue;
    }
    if (open === undefined) {
      throw unmatchedEnd(subject, marker, line.number);
    }
    if (open.id !== marker.id) {
      throw mismatchedEnd(subject, marker, line.number, open.id, open.beginLine);
    }
    regions.push({
      id: open.id,
      beginLine: open.beginLine,
      endLine: line.number,
      start: open.beginStart,
      end: line.next,
      bodyStart: open.bodyStart,
      bodyEnd: line.start,
    });
    open = undefined;
  }
  if (open !== undefined) {
    throw unmatchedBegin(subject, open.id, open.beginLine);
  }
  return { bom, text, regions };
}

/**
 * Decode a region file strictly and parse it. Invalid UTF-8 is refused by the
 * shared decoder with its byte offset; the design requires the same decoder the
 * structured path uses, so a mis-encoded file is never read as U+FFFD.
 */
export function parseRegionBytes(bytes: Uint8Array, subject: string): ParsedRegionFile {
  return parseRegionText(decodeUtf8(bytes, subject), subject);
}

/**
 * Parse a region file the plan can own. A marker whose id is not one this plan
 * knows is a typed refusal, not a region the tool ignores: ignoring it would
 * leave bytes in the file that no later `generate` or `check` accounts for.
 */
function knownRegionIdsOnly(
  parsed: ParsedRegionFile,
  knownIds: readonly string[],
  subject: string,
): ParsedRegionFile {
  for (const span of parsed.regions) {
    if (!knownIds.includes(span.id)) {
      throw invalidConfig(
        `${subject} line ${span.beginLine} names region "${span.id}", which this plan does not know`,
        {
          subject,
          action: 'remove the unknown region, or move the file aside deliberately',
        },
      );
    }
  }
  return parsed;
}

export function parseManagedRegionText(
  source: string,
  subject: string,
  knownIds: readonly string[],
): ParsedRegionFile {
  return knownRegionIdsOnly(parseRegionText(source, subject), knownIds, subject);
}

/** Decode and parse a region file the plan can own, refusing an unknown id. */
export function parseManagedRegionBytes(
  bytes: Uint8Array,
  subject: string,
  knownIds: readonly string[],
): ParsedRegionFile {
  return knownRegionIdsOnly(parseRegionBytes(bytes, subject), knownIds, subject);
}

/** The exact body between a region's marker lines, or `undefined` when it is absent. */
export function regionBody(parsed: ParsedRegionFile, regionId: string): string | undefined {
  const span = parsed.regions.find((region) => region.id === regionId);
  return span === undefined ? undefined : parsed.text.slice(span.bodyStart, span.bodyEnd);
}

/**
 * Refuse a rendered body that already carries a marker line. The markers are
 * written by `generate`, so a marker in a rendered body would either nest a
 * region or be silently overwritten; both make the file unreadable later.
 */
export function assertNoRegionMarkers(source: string, subject: string): void {
  const text = source.startsWith(BOM) ? source.slice(1) : source;
  for (const line of splitLines(text)) {
    if (line.content.includes(REGION_MARKER_PREFIX)) {
      throw invalidConfig(
        `${subject} line ${line.number}: the rendered body contains a region marker`,
        {
          subject,
          action:
            'remove the marker from the rule body; regions are written by generate, never rendered',
        },
      );
    }
  }
}

export type RegionMergeOptions = {
  /** The region is recorded in the committed lockfile, so this run already owns it. */
  owned: boolean;
  /** `--adopt` was passed: take over an existing planned managed output. */
  adopt: boolean;
};

function unrecordedRegion(subject: string, regionId: string, body: string): FarnaError {
  return driftRefused(
    `refusing to write region "${regionId}" in ${subject}: the file is not recorded in the committed lockfile`,
    {
      subject,
      action: 'run generate --adopt to append a managed region, or add the marker pair and re-run',
      detail: regionBlock(regionId, body),
    },
  );
}

/**
 * The whole-file text a `generate` writes for one region.
 *
 * - absent file: create it with the marker pair and the body;
 * - an owned or `--adopt` file that already carries the region: replace the
 *   body only, preserving every byte before the begin marker and after the end
 *   marker, including a BOM and a missing final newline;
 * - an `--adopt` unmarked file: append one blank line, the marker pair and the
 *   body, keeping every existing byte;
 * - an unrecorded file without `--adopt`: refuse, naming the block to add and
 *   `generate --adopt`. A marker is not proof this tool wrote it.
 *
 * A malformed file, a CRLF file, an unknown region id or invalid UTF-8 (through
 * `parseRegionBytes`) is refused before any text is assembled.
 */
export function mergeRegionText(
  existing: string | undefined,
  regionId: string,
  renderedBody: string,
  subject: string,
  options: RegionMergeOptions,
): string {
  const body = normaliseRegionBody(renderedBody);
  if (existing === undefined) {
    return regionBlock(regionId, body);
  }
  const parsed = parseManagedRegionText(existing, subject, [regionId]);
  const span = parsed.regions.find((region) => region.id === regionId);
  if (span !== undefined) {
    if (!options.owned && !options.adopt) {
      throw unrecordedRegion(subject, regionId, body);
    }
    return `${parsed.bom}${parsed.text.slice(0, span.bodyStart)}${body}${parsed.text.slice(span.bodyEnd)}`;
  }
  if (!options.adopt) {
    throw unrecordedRegion(subject, regionId, body);
  }
  const separator = parsed.text.length === 0 ? '' : parsed.text.endsWith('\n') ? '\n' : '\n\n';
  return `${parsed.bom}${parsed.text}${separator}${regionBlock(regionId, body)}`;
}

export type RegionStrip = {
  /** The whole-file text after the region's three lines are removed. */
  text: string;
  /** Whether any non-whitespace content remains outside the region. */
  remaining: boolean;
};

/**
 * Remove one region's marker pair and body, keeping every other byte. The end
 * marker's terminator goes with it, so a region-only file becomes empty rather
 * than a file of blank lines. Returns `undefined` when the region is already
 * absent, which is how an orphan is dropped without touching the file.
 */
export function stripRegion(parsed: ParsedRegionFile, regionId: string): RegionStrip | undefined {
  const span = parsed.regions.find((region) => region.id === regionId);
  if (span === undefined) {
    return undefined;
  }
  const text = `${parsed.bom}${parsed.text.slice(0, span.start)}${parsed.text.slice(span.end)}`;
  return { text, remaining: text.slice(parsed.bom.length).trim().length > 0 };
}
