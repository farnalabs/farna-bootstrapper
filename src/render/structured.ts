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
 * Merge the generated document into the user's: every owned key is replaced by
 * the generated value, and every other key keeps the value the user gave it.
 * Key order outside our keys is preserved by value, not by byte, which is the
 * design's honest rule (`ownership.md` section 5): we preserve values, not
 * whitespace.
 */
export function mergeStructured(
  existing: Record<string, unknown> | undefined,
  generated: Record<string, unknown>,
  ownedKeys: readonly string[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) };
  for (const key of ownedKeys) {
    if (Object.hasOwn(generated, key)) {
      merged[key] = generated[key];
    }
  }
  return merged;
}

/** The canonical bytes for a merged structured document. */
export function serialiseStructured(document: Record<string, unknown>): string {
  return canonicalJsonFile(document);
}

/** The canonical JSON of the owned subset, for an equality comparison. */
export function canonicalOwnedSubset(
  document: Record<string, unknown>,
  ownedKeys: readonly string[],
): string {
  return canonicalJson(ownedSubset(document, ownedKeys));
}
