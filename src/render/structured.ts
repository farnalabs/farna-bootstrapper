import { applyEdits, type Edit, type Node, type ParseError, parseTree } from 'jsonc-parser';
import { CLAUDE_MCP_FILE, CLAUDE_SETTINGS_FILE, OPENCODE_CONFIG_FILE } from '../core/constants.js';
import { invalidConfig } from '../core/errors.js';
import { canonicalJson, canonicalJsonFile, parseJsonc, sha256Hex } from '../core/json.js';

/**
 * The managed paths this tool owns **part** of, and the exact top-level keys it
 * owns in each. Every entry is a file a user is likely to keep their own keys
 * in: `opencode.jsonc` carries `$schema`, `theme`, `instructions` and extra
 * providers beside the MCP servers this tool writes; `.mcp.json` is a shared
 * MCP document; `.claude/settings.json` carries `$schema` and `permissions`
 * beside the hooks this tool writes.
 *
 * Owning the whole file destroyed those keys on every `generate`, and comparing
 * the whole file on `check` reported a user's own edit as our drift. Owning the
 * declared keys lets both hold: we replace what we write, and we preserve what
 * we do not.
 */
export const STRUCTURED_OUTPUTS: Readonly<Record<string, readonly string[]>> = {
  [OPENCODE_CONFIG_FILE]: ['mcp'],
  [CLAUDE_MCP_FILE]: ['mcpServers'],
  [CLAUDE_SETTINGS_FILE]: ['hooks'],
};

/** The keys this tool owns in a structured file, or `undefined` for a whole file. */
export function structuredOwnedKeys(path: string): readonly string[] | undefined {
  return STRUCTURED_OUTPUTS[path];
}

const BOM = '\uFEFF';

/**
 * Split a leading byte-order mark from the text it precedes.
 *
 * Source files are refused when they start with a BOM (`parseJsonc`), but a
 * *target* document is the user's: some editors save one, and this tool must
 * preserve the bytes it does not own. The editor therefore parses the body and
 * re-attaches the mark unchanged, so an edit never silently strips it.
 */
function splitBom(text: string): { bom: string; body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(1) } : { bom: '', body: text };
}

/** Parse a structured file, refusing anything that is not a JSON object. */
export function parseStructuredDocument(text: string, subject: string): Record<string, unknown> {
  const value = parseJsonc(splitBom(text).body, { subject });
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

/** The whitespace that precedes `offset` on its line, or `undefined` when the
 * token shares a line with something else (an inline member cannot supply an
 * indentation for a multi-line value). */
function lineIndent(text: string, offset: number): string | undefined {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  return /^[ \t]*$/.test(prefix) ? prefix : undefined;
}

/** The `property` nodes of a parsed object, in document order. */
function objectProperties(root: Node): Node[] {
  return (root.children ?? []).filter((child) => child.type === 'property');
}

function propertyName(property: Node): string {
  const [keyNode] = property.children ?? [];
  return keyNode === undefined ? '' : String(keyNode.value);
}

function propertyValue(property: Node): Node | undefined {
  return property.children?.[1];
}

function findProperty(root: Node, key: string): Node | undefined {
  return objectProperties(root).find((property) => propertyName(property) === key);
}

/**
 * Parse the edit target into a tree. `parseStructuredDocument` has already
 * validated the text, so a failure here means the two parsers disagree, which
 * is never something to edit through.
 */
function parseObjectTree(text: string, subject: string): Node {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || root === undefined || root.type !== 'object') {
    throw invalidConfig(`${subject} must contain a JSON object`, {
      subject,
      action: 'replace the top-level value with an object, or move the file aside',
    });
  }
  return root;
}

/**
 * A node the caller has already located must exist. A miss here is not a user
 * error: the document parsed and its shape was checked, so it means the two
 * parsers disagree, and editing through it would corrupt the file.
 */
function requireNode(node: Node | undefined, subject: string): Node {
  if (node === undefined) {
    throw invalidConfig(`${subject} has a property this tool cannot locate`, {
      subject,
      action: 'restore the document, or move it aside deliberately, then re-run generate',
    });
  }
  return node;
}

/** JSON at a fixed indentation, so a replacement value lines up with its key. */
function formatValue(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replaceAll('\n', `\n${indent}`);
}

/**
 * Replace only the value range of the owned top-level property. The key, the
 * comment above it, the separators and every other member keep their bytes;
 * `jsonc-parser`'s `modify` is not used because it reformats the neighbouring
 * member and drops a comment that sits above the property.
 */
function setStructuredKey(
  text: string,
  root: Node,
  key: string,
  value: unknown,
  subject: string,
): string {
  const property = findProperty(root, key);
  if (property === undefined) {
    return insertStructuredKey(text, root, key, value, subject);
  }
  const target = requireNode(propertyValue(property), subject);
  const indent = lineIndent(text, property.offset) ?? '';
  const edit: Edit = {
    offset: target.offset,
    length: target.length,
    content: formatValue(value, indent),
  };
  return applyEdits(text, [edit]);
}

/**
 * Insert an absent owned property after the last member (or inside an empty
 * object). Adding one comma is the only change to the existing text: the last
 * foreign member keeps its exact bytes, whether it is a string, number,
 * boolean, object or array.
 *
 * When the document already ends its member list with a trailing comma, the new
 * member follows that comma and the trivia after it, so no second comma is
 * added.
 */
function insertStructuredKey(
  text: string,
  root: Node,
  key: string,
  value: unknown,
  subject: string,
): string {
  const properties = objectProperties(root);
  const close = root.offset + root.length - 1;
  const rootIndent = lineIndent(text, root.offset) ?? '';
  if (properties.length === 0) {
    const indent = `${rootIndent}  `;
    const content = `\n${indent}${JSON.stringify(key)}: ${formatValue(value, indent)}\n${rootIndent}`;
    return applyEdits(text, [{ offset: close, length: 0, content }]);
  }
  const last = requireNode(properties[properties.length - 1], subject);
  const indent =
    properties
      .map((property) => lineIndent(text, property.offset))
      .find((indent) => indent !== undefined) ?? `${rootIndent}  `;
  const after = skipTrivia(text, last.offset + last.length);
  const hasComma = text[after] === ',';
  const content = `${hasComma ? '' : ','}\n${indent}${JSON.stringify(key)}: ${formatValue(value, indent)}`;
  return applyEdits(text, [
    { offset: hasComma ? after + 1 : last.offset + last.length, length: 0, content },
  ]);
}

/**
 * Delete one top-level property and only the separator needed to keep the
 * document valid: the comma that follows it, or, when it is the final member
 * with no trailing comma, the comma that precedes it. A comment above the
 * property and every other byte are left untouched.
 */
function deleteStructuredKey(text: string, root: Node, key: string, subject: string): string {
  const properties = objectProperties(root);
  const index = properties.findIndex((property) => propertyName(property) === key);
  if (index === -1) {
    return text;
  }
  const property = requireNode(properties[index], subject);
  const edits: Edit[] = [{ offset: property.offset, length: property.length, content: '' }];
  const after = skipTrivia(text, property.offset + property.length);
  if (text[after] === ',') {
    edits.push({ offset: after, length: 1, content: '' });
  } else {
    const previous = index === 0 ? undefined : properties[index - 1];
    if (previous !== undefined) {
      const separator = skipTrivia(text, previous.offset + previous.length);
      if (text[separator] === ',') {
        edits.push({ offset: separator, length: 1, content: '' });
      }
    }
  }
  return applyEdits(text, edits);
}

/** Apply one owned-key change to a validated document. */
function editStructuredKey(
  text: string,
  key: string,
  generated: Record<string, unknown>,
  subject: string,
): string {
  const root = parseObjectTree(text, subject);
  return Object.hasOwn(generated, key)
    ? setStructuredKey(text, root, key, generated[key], subject)
    : deleteStructuredKey(text, root, key, subject);
}

/**
 * Merge the generated document into the user's **in place**: set every owned
 * key the generated document carries, delete every owned key it does not.
 *
 * This is a byte-preserving edit, not a parse/re-serialise round trip. Each
 * owned key is changed through its exact range: a set replaces the value only,
 * a delete removes the property and the one separator that keeps the document
 * valid. Comments, whitespace, key order and every foreign member survive.
 */
export function mergeStructuredText(
  existingText: string,
  generatedText: string,
  ownedKeys: readonly string[],
  subject: string,
): string {
  // Parse both first: a document that is not a JSON object is refused before
  // any edit is assembled, so a malformed generated file never reaches the disk.
  const { bom, body } = splitBom(existingText);
  parseStructuredDocument(body, subject);
  const generated = parseStructuredDocument(generatedText, subject);
  let text = body;
  for (const key of ownedKeys) {
    text = editStructuredKey(text, key, generated, subject);
  }
  // The merge must leave a document this tool can read back; a malformed result
  // is a bug in the edit, never something to write to disk.
  parseStructuredDocument(text, subject);
  return `${bom}${text}`;
}

/** The canonical JSON of the owned subset, for an equality comparison. */
export function canonicalOwnedSubset(
  document: Record<string, unknown>,
  ownedKeys: readonly string[],
): string {
  return canonicalJson(ownedSubset(document, ownedKeys));
}
