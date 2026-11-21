import { describe, expect, it } from 'vitest';
import { FarnaError } from '../../src/core/errors.js';
import {
  canonicalJson,
  canonicalJsonFile,
  compareCodepoints,
  parseJsonc,
  sha256Hex,
} from '../../src/core/json.js';

describe('canonical json and hashing', () => {
  it('sorts keys by codepoint and never by locale', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(['b', 'a', 'Z', 'A'].sort(compareCodepoints)).toEqual(['A', 'Z', 'a', 'b']);
  });

  it('writes files with two spaces and exactly one trailing newline', () => {
    const text = canonicalJsonFile({ b: true, a: 1 });
    expect(text).toBe('{\n  "a": 1,\n  "b": true\n}\n');
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('omits undefined values from canonical output', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('hashes bytes deterministically', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('parses JSONC with comments and trailing commas', () => {
    const value = parseJsonc('{\n  // a comment\n  "a": 1,\n}\n', { subject: 'test.jsonc' });
    expect(value).toEqual({ a: 1 });
  });

  it('rejects duplicate keys at any depth', () => {
    expect(() => parseJsonc('{"a":{"b":1,"b":2}}', { subject: 'test.jsonc' })).toThrowError(
      FarnaError,
    );
    try {
      parseJsonc('{"a":{"b":1,"b":2}}', { subject: 'test.jsonc' });
    } catch (error) {
      expect((error as FarnaError).message).toContain('duplicate key "a.b"');
    }
  });

  it('rejects a UTF-8 BOM', () => {
    expect(() => parseJsonc('\uFEFF{"a":1}', { subject: 'test.jsonc' })).toThrowError(FarnaError);
  });

  it('maps a pathologically deep document to F001 instead of an untyped RangeError', () => {
    const depth = 50_000;
    const text = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
    let error: unknown;
    try {
      parseJsonc(text, { subject: '.farna/config.jsonc' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FarnaError);
    expect((error as FarnaError).code).toBe('F001_INVALID_CONFIG');
    expect((error as FarnaError).message).toContain('nested too deeply');
    expect((error as FarnaError).subject).toBe('.farna/config.jsonc');
  });
});
