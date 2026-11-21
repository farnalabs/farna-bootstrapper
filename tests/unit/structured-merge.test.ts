import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../../src/core/json.js';
import { mergeStructuredText } from '../../src/render/structured.js';

const SUBJECT = 'opencode.jsonc';
const OWNED = ['mcp'];

/** The declaration `generate` writes for the fixture's MCP server. */
const MCP = { servers: { scan: { type: 'local', command: ['npx', '-y', 'example-scan'] } } };
const GENERATED = `${JSON.stringify({ mcp: MCP }, null, 2)}\n`;
const REMOVED = '{}\n';
const OLD_VALUE = '{ "servers": {} }';

function merge(existing: string, generated = GENERATED): string {
  return mergeStructuredText(existing, generated, OWNED, SUBJECT);
}

function documentOf(text: string): Record<string, unknown> {
  return parseJsonc<Record<string, unknown>>(text, { subject: SUBJECT });
}

describe('structured key merge edits only the owned key', () => {
  it('replaces only the mcp value, leaving a foreign object and array byte for byte', () => {
    const existing = [
      '{',
      '  "theme": "dark",',
      '  "table": { "a": 1, "b": [2, 3] },',
      '  "list": [1,2,3],',
      `  "mcp": ${OLD_VALUE}`,
      '}',
      '',
    ].join('\n');

    const merged = merge(existing);

    expect(documentOf(merged)).toEqual({
      theme: 'dark',
      table: { a: 1, b: [2, 3] },
      list: [1, 2, 3],
      mcp: MCP,
    });
    expect(merged).toContain('"table": { "a": 1, "b": [2, 3] }');
    expect(merged).toContain('"list": [1,2,3]');
    // Everything before the value and everything after it is untouched byte for
    // byte: only the value range of the owned key was replaced.
    const valueStart = existing.indexOf(OLD_VALUE);
    expect(merged.slice(0, valueStart)).toBe(existing.slice(0, valueStart));
    expect(merged.endsWith(existing.slice(valueStart + OLD_VALUE.length))).toBe(true);
  });

  it('does not reformat the member that follows mcp on a set', () => {
    const existing = ['{', `  "mcp": ${OLD_VALUE},`, '  "list": [1,2,3]', '}', ''].join('\n');

    const merged = merge(existing);

    expect(merged).toContain('"list": [1,2,3]');
    expect(documentOf(merged)).toEqual({ mcp: MCP, list: [1, 2, 3] });
  });

  it('deletes mcp and its separator, leaving a foreign object and array byte for byte', () => {
    const existing = [
      '{',
      `  "mcp": ${OLD_VALUE},`,
      '  "table": { "a": 1, "b": [2, 3] },',
      '  "list": [1,2,3]',
      '}',
      '',
    ].join('\n');

    const deleted = merge(existing, REMOVED);

    expect(documentOf(deleted)).toEqual({
      table: { a: 1, b: [2, 3] },
      list: [1, 2, 3],
    });
    expect(deleted).toContain('"table": { "a": 1, "b": [2, 3] }');
    expect(deleted).toContain('"list": [1,2,3]');
    // Only the property text and the comma that followed it are removed; the
    // whitespace around them and every other byte stay exactly as they were.
    const propertyStart = existing.indexOf('"mcp"');
    const followingComma = existing.indexOf(',', propertyStart);
    expect(deleted).toBe(existing.slice(0, propertyStart) + existing.slice(followingComma + 1));
  });

  it('keeps a line comment directly above mcp across a set and a delete', () => {
    const existing = [
      '// user header',
      '{',
      '  "theme": "dark",',
      '  // the MCP declarations this tool writes',
      `  "mcp": ${OLD_VALUE}`,
      '}',
      '',
    ].join('\n');

    const merged = merge(existing);
    expect(merged).toContain('  // the MCP declarations this tool writes\n  "mcp": {');
    expect(documentOf(merged)).toEqual({ theme: 'dark', mcp: MCP });

    const deleted = merge(existing, REMOVED);
    expect(deleted).toContain('  // the MCP declarations this tool writes');
    expect(deleted).not.toContain('"mcp"');
    expect(documentOf(deleted)).toEqual({ theme: 'dark' });
  });

  it('keeps a block comment directly above mcp across a set and a delete', () => {
    const existing = [
      '{',
      '  "theme": "dark",',
      '  /* the MCP declarations this tool writes */',
      `  "mcp": ${OLD_VALUE}`,
      '}',
      '',
    ].join('\n');

    expect(merge(existing)).toContain('  /* the MCP declarations this tool writes */\n  "mcp": {');
    const deleted = merge(existing, REMOVED);
    expect(deleted).toContain('  /* the MCP declarations this tool writes */');
    expect(documentOf(deleted)).toEqual({ theme: 'dark' });
  });

  const memberCases: ReadonlyArray<{ name: string; existing: string; rest: object }> = [
    {
      name: 'first member',
      existing: ['{', `  "mcp": ${OLD_VALUE},`, '  "a": 1,', '  "b": 2', '}', ''].join('\n'),
      rest: { a: 1, b: 2 },
    },
    {
      name: 'middle member',
      existing: ['{', '  "a": 1,', `  "mcp": ${OLD_VALUE},`, '  "b": 2', '}', ''].join('\n'),
      rest: { a: 1, b: 2 },
    },
    {
      name: 'last member',
      existing: ['{', '  "a": 1,', '  "b": 2,', `  "mcp": ${OLD_VALUE}`, '}', ''].join('\n'),
      rest: { a: 1, b: 2 },
    },
    {
      name: 'first member with a trailing comma',
      existing: ['{', `  "mcp": ${OLD_VALUE},`, '  "a": 1,', '}', ''].join('\n'),
      rest: { a: 1 },
    },
    {
      name: 'middle member with a trailing comma',
      existing: ['{', '  "a": 1,', `  "mcp": ${OLD_VALUE},`, '  "b": 2,', '}', ''].join('\n'),
      rest: { a: 1, b: 2 },
    },
    {
      name: 'last member with a trailing comma',
      existing: ['{', '  "a": 1,', `  "mcp": ${OLD_VALUE},`, '}', ''].join('\n'),
      rest: { a: 1 },
    },
  ];

  for (const { name, existing, rest } of memberCases) {
    it(`sets and deletes mcp as the ${name}`, () => {
      const merged = merge(existing);
      expect(documentOf(merged)).toEqual({ ...rest, mcp: MCP });

      const deleted = merge(existing, REMOVED);
      expect(documentOf(deleted)).toEqual(rest);
      expect(deleted).not.toContain('"mcp"');
    });
  }

  const insertionCases: ReadonlyArray<{
    name: string;
    key: string;
    member: string;
    value: unknown;
  }> = [
    { name: 'string', key: 'theme', member: '"theme": "dark"', value: 'dark' },
    { name: 'number', key: 'retries', member: '"retries": 3', value: 3 },
    { name: 'boolean', key: 'auto', member: '"auto": true', value: true },
    {
      name: 'object',
      key: 'table',
      member: '"table": { "a": 1, "b": [2, 3] }',
      value: { a: 1, b: [2, 3] },
    },
    {
      name: 'array',
      key: 'instructions',
      member: '"instructions": ["AGENTS.md", "README.md"]',
      value: ['AGENTS.md', 'README.md'],
    },
  ];

  for (const { name, key, member, value } of insertionCases) {
    it(`inserts mcp after a foreign ${name} without reformatting it`, () => {
      const existing = `{\n  ${member}\n}\n`;

      const merged = merge(existing);

      // The foreign member is the exact same bytes; the insertion adds a comma
      // and the new member, nothing else.
      expect(merged.startsWith(`{\n  ${member},\n  "mcp": {`)).toBe(true);
      expect(documentOf(merged)).toEqual({ [key]: value, mcp: MCP });
    });
  }

  it('inserts mcp after an existing trailing comma without adding another comma', () => {
    const existing = ['{', '  "theme": "dark",', '}', ''].join('\n');

    const merged = merge(existing);

    expect(merged).toContain('"theme": "dark"');
    // One member separator between theme and mcp; no second comma is added for
    // the trailing comma that already separated theme from the closing brace.
    expect(merged.match(/,\n {2}"/g)).toHaveLength(1);
    expect(documentOf(merged)).toEqual({ theme: 'dark', mcp: MCP });
  });

  it('inserts mcp into an empty object', () => {
    const merged = merge('{}\n');

    expect(merged.startsWith('{\n  "mcp": {\n')).toBe(true);
    expect(documentOf(merged)).toEqual({ mcp: MCP });
  });

  it('replaces and deletes mcp when it is the only member', () => {
    const existing = ['{', `  "mcp": ${OLD_VALUE}`, '}', ''].join('\n');

    expect(documentOf(merge(existing))).toEqual({ mcp: MCP });
    const deleted = merge(existing, REMOVED);
    expect(documentOf(deleted)).toEqual({});
    expect(deleted).not.toContain('"mcp"');
  });

  it('leaves only whitespace and comments when the owned key is the only member', () => {
    const existing = [
      '// user header',
      '{',
      '  // about the owned key',
      `  "mcp": ${OLD_VALUE}`,
      '}',
      '',
    ].join('\n');

    const deleted = merge(existing, REMOVED);

    expect(deleted).toContain('// user header');
    expect(deleted).toContain('// about the owned key');
    expect(documentOf(deleted)).toEqual({});
    // Strip the comments and every remaining character is whitespace or a brace:
    // no member survives the delete.
    expect(deleted.replace(/\/\/[^\n]*/g, '').replace(/[{}\s]/g, '')).toBe('');
  });

  it('preserves a leading byte-order mark and edits the body', () => {
    const body = ['{', '  "theme": "dark",', `  "mcp": ${OLD_VALUE}`, '}', ''].join('\n');
    const existing = `\uFEFF${body}`;

    const merged = merge(existing);
    expect(merged.startsWith('\uFEFF')).toBe(true);
    expect(documentOf(merged.slice(1))).toEqual({ theme: 'dark', mcp: MCP });

    const deleted = merge(existing, REMOVED);
    expect(deleted.startsWith('\uFEFF')).toBe(true);
    expect(documentOf(deleted.slice(1))).toEqual({ theme: 'dark' });
  });

  it('preserves a byte-order mark while inserting an absent mcp', () => {
    const existing = '\uFEFF{\n  "theme": "dark"\n}\n';

    const merged = merge(existing);

    expect(merged.startsWith('\uFEFF')).toBe(true);
    expect(merged).toContain('"theme": "dark"');
    expect(documentOf(merged.slice(1))).toEqual({ theme: 'dark', mcp: MCP });
  });

  it('returns the document unchanged when the owned value already matches the render', () => {
    const document = `${JSON.stringify({ theme: 'dark', mcp: MCP }, null, 2)}\n`;

    expect(merge(document)).toBe(document);
  });
});
