import { createHash } from 'node:crypto';
import {
  getNodeValue,
  type Node,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';
import { invalidConfig } from './errors.js';

/** Codepoint order, never locale order. */
export function compareCodepoints(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareCodepoints)) {
      const entry = source[key];
      if (entry !== undefined) {
        sorted[key] = sortValue(entry);
      }
    }
    return sorted;
  }
  return value;
}

/** Canonical JSON for digests: sorted keys, no whitespace, no trailing newline. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** Canonical JSON for files: sorted keys, two spaces, exactly one trailing newline. */
export function canonicalJsonFile(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function hasBom(text: string): boolean {
  return text.charCodeAt(0) === 0xfeff;
}

function findForbiddenKey(node: Node, pointer: string): string | undefined {
  if (node.type === 'object') {
    for (const property of node.children ?? []) {
      if (property.type !== 'property') {
        continue;
      }
      const [keyNode, valueNode] = property.children ?? [];
      if (keyNode === undefined || valueNode === undefined) {
        continue;
      }
      const key = String(keyNode.value);
      if (key === '__proto__') {
        return pointer === '' ? key : `${pointer}.${key}`;
      }
      const nested = findForbiddenKey(valueNode, pointer === '' ? key : `${pointer}.${key}`);
      if (nested !== undefined) {
        return nested;
      }
    }
    return undefined;
  }
  if (node.type === 'array') {
    const children = node.children ?? [];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === undefined) {
        continue;
      }
      const nested = findForbiddenKey(child, `${pointer}[${index}]`);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

function findDuplicateKey(node: Node, pointer: string): string | undefined {
  if (node.type === 'object') {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      if (property.type !== 'property') {
        continue;
      }
      const [keyNode, valueNode] = property.children ?? [];
      if (keyNode === undefined || valueNode === undefined) {
        continue;
      }
      const key = String(keyNode.value);
      if (seen.has(key)) {
        return pointer === '' ? key : `${pointer}.${key}`;
      }
      seen.add(key);
      const nested = findDuplicateKey(valueNode, pointer === '' ? key : `${pointer}.${key}`);
      if (nested !== undefined) {
        return nested;
      }
    }
    return undefined;
  }
  if (node.type === 'array') {
    const children = node.children ?? [];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === undefined) {
        continue;
      }
      const nested = findDuplicateKey(child, `${pointer}[${index}]`);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

export type JsoncParseOptions = {
  /** The file path or label printed in an error, relative to the repository root. */
  subject: string;
};

/**
 * Parse JSONC with comments and trailing commas, rejecting duplicate keys at
 * every depth. CRLF is normalised before parsing.
 *
 * No nesting-depth limit is imposed by the grammar, so a repository-controlled
 * file can be deep enough to exhaust the stack. That surfaces as a `RangeError`
 * from the parser or the duplicate-key walk; it is mapped to the same typed
 * diagnostic as any other invalid input, never allowed to escape untyped.
 */
export function parseJsonc<T = unknown>(text: string, options: JsoncParseOptions): T {
  if (hasBom(text)) {
    throw invalidConfig('file starts with a UTF-8 BOM', {
      subject: options.subject,
      action: 'save the file as UTF-8 without a BOM',
    });
  }
  const normalised = text.replace(/\r\n/g, '\n');
  try {
    const errors: ParseError[] = [];
    const tree = parseTree(normalised, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0 || tree === undefined) {
      const first = errors[0];
      const detail =
        first === undefined
          ? 'file did not parse'
          : `${printParseErrorCode(first.error)} at offset ${first.offset}`;
      throw invalidConfig(detail, { subject: options.subject });
    }
    const forbidden = findForbiddenKey(tree, '');
    if (forbidden !== undefined) {
      throw invalidConfig(`forbidden key "${forbidden}"`, {
        subject: options.subject,
        action:
          'rename the key: "__proto__" is never read or written, and accepting it would silently drop a declaration',
      });
    }
    const duplicate = findDuplicateKey(tree, '');
    if (duplicate !== undefined) {
      throw invalidConfig(`duplicate key "${duplicate}"`, {
        subject: options.subject,
        action: 'remove one of the duplicate keys; the last value is never silently kept',
      });
    }
    return getNodeValue(tree) as T;
  } catch (error) {
    if (error instanceof RangeError) {
      throw invalidConfig('file is nested too deeply to parse', {
        subject: options.subject,
        action: 'flatten the structure; a file this deep would exhaust the stack',
      });
    }
    throw error;
  }
}
