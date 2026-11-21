import {
  applyEdits,
  type Edit,
  type FormattingOptions,
  findNodeAtLocation,
  modify,
  parseTree,
} from 'jsonc-parser';
import { OPENCODE_CONFIG_FILE } from '../core/constants.js';
import { invalidConfig } from '../core/errors.js';
import { canonicalJson, canonicalJsonFile, parseJsonc, sha256Hex } from '../core/json.js';

/**
 * The managed paths this tool owns **part** of, and the exact top-level keys it
 * owns in each. `opencode.jsonc` is the only such file in this build: it is the
 * one place a user is likely to keep their own `$schema`, `theme`,
 * `instructions` or extra providers beside the MCP servers this tool writes.
 *
 * Owning the whole file destroyed those keys on every `generate`, and comparing
 * the whole file on `check` reported a user's own edit as our drift. Owning the
 * declared keys lets both hold: we replace what we write, and we preserve what
 * we do not.
 */
export const STRUCTURED_OUTPUTS: Readonly<Record<string, readonly string[]>> = {
  [OPENCODE_CONFIG_FILE]: ['mcp'],
};

/** The keys this tool owns in a structured file, or `undefined` for a whole file. */
export function structuredOwnedKeys(path: string): readonly string[] | undefined {
  return STRUCTURED_OUTPUTS[path];
}

/** Parse a structured file, refusing anything that is not a JSON object. */
export function parseStructuredDocument(text: string, subject: string): Record<string, unknown> {
  const value = parseJsonc(text, { subject });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidConfig(`${subject} must contain a JSON object`, {
      subject,
      action: 'replace the top-level value with an object, or move the file aside',
    });
  }
  return value as Record<string, unknown>;
}

/** The subset of a document this tool owns. A key that is absent is not invented. */
export function ownedSubset(
  document: Record<string, unknown>,
  ownedKeys: readonly string[],
): Record<string, unknown> {
  const owned: Record<string, unknown> = {};
  for (const key of ownedKeys) {
    if (Object.hasOwn(document, key)) {
      owned[key] = document[key];
    }
  }
  return owned;
}

/** The digest of the owned subset. Sorted keys, two spaces, one trailing newline. */
export function structuredOwnedDigest(
  document: Record<string, unknown>,
  ownedKeys: readonly string[],
): { sha256: string; size: number } {
  const canonical = canonicalJsonFile(ownedSubset(document, ownedKeys));
  return { sha256: sha256Hex(canonical), size: Buffer.byteLength(canonical) };
}

/**
 * The JavaScript format jsonc-parser uses when it has to insert or replace a
 * value. Every byte it does not touch is preserved, so the user's comments,
 * blank lines, key order and whitespace survive a merge.
 */
const INSERT_FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

/** Skip whitespace and comments forward, so a separator can be found exactly. */
function skipTrivia(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const character = text[index];
    if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
      index += 1;
      continue;
    }
    if (character === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }
    return index;
  }
  return index;
}

/**
 * Delete one top-level property without leaving a comma that has nothing to
 * separate. `modify(text, [key], undefined)` is the primary edit; it leaves
 * `{ , }` when the deleted property is the last one and the document has a
 * trailing comma (valid JSONC syntax), so the result is parsed and, only when
 * that fails, the property and its separator are removed directly.
 *
 * The fallback removes the property text and, when a comma follows it, that
 * comma too. A comment between the property and the comma is left in place, so
 * the edit still preserves every byte the user wrote outside the owned key.
 */
function deleteStructuredKey(text: string, key: string, subject: string): string {
  const edited = applyEdits(
    text,
    modify(text, [key], undefined, { formattingOptions: INSERT_FORMAT }),
  );
  try {
    parseStructuredDocument(edited, subject);
    return edited;
  } catch {
    const root = parseTree(text);
    if (root === undefined || root.type !== 'object' || root.children === undefined) {
      return edited;
    }
    const value = findNodeAtLocation(root, [key]);
    const property = value?.parent;
    if (property === undefined) {
      return edited;
    }
    const edits: Edit[] = [{ offset: property.offset, length: property.length, content: '' }];
    const separator = skipTrivia(text, property.offset + property.length);
    if (text[separator] === ',') {
      edits.push({ offset: separator, length: 1, content: '' });
    }
    return applyEdits(text, edits);
  }
}

/**
 * Merge the generated document into the user's **in place**: set every owned
 * key the generated document carries, delete every owned key it does not.
 *
 * This is a byte-preserving edit, not a parse/re-serialise round trip. The
 * previous implementation rebuilt the whole document, which destroyed every
 * comment and silently reformatted the user's keys; a merge must only touch the
 * bytes of the keys it owns.
 */
export function mergeStructuredText(
  existingText: string,
  generatedText: string,
  ownedKeys: readonly string[],
  subject: string,
): string {
  // Parse both first: a document that is not a JSON object is refused before
  // any edit is assembled, so a malformed generated file never reaches the disk.
  parseStructuredDocument(existingText, subject);
  const generated = parseStructuredDocument(generatedText, subject);
  let text = existingText;
  for (const key of ownedKeys) {
    if (Object.hasOwn(generated, key)) {
      text = applyEdits(
        text,
        modify(text, [key], generated[key], { formattingOptions: INSERT_FORMAT }),
      );
    } else {
      // `undefined` is jsonc-parser's delete instruction: removing the last MCP
      // declaration deletes the owned key instead of leaving a stale one behind.
      text = deleteStructuredKey(text, key, subject);
    }
  }
  // The merge must leave a document this tool can read back; a malformed result
  // is a bug in the edit, never something to write to disk.
  parseStructuredDocument(text, subject);
  return text;
}

/** The canonical JSON of the owned subset, for an equality comparison. */
export function canonicalOwnedSubset(
  document: Record<string, unknown>,
  ownedKeys: readonly string[],
): string {
  return canonicalJson(ownedSubset(document, ownedKeys));
}
