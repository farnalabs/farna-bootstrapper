import { describe, expect, it } from 'vitest';
import type { FarnaError } from '../../src/core/errors.js';
import {
  assertNoRegionMarkers,
  mergeRegionText,
  normaliseRegionBody,
  parseManagedRegionBytes,
  parseManagedRegionText,
  parseRegionBytes,
  parseRegionText,
  regionBeginMarker,
  regionBlock,
  regionBody,
  regionEndMarker,
  regionEntryKey,
  regionIdOf,
  stripRegion,
} from '../../src/render/region.js';

const SUBJECT = 'CLAUDE.md';
const ID = 'claude-instructions';

/** Run a synchronous call that must throw, and return the typed failure. */
function captured(run: () => unknown): FarnaError {
  try {
    run();
  } catch (error) {
    return error as FarnaError;
  }
  throw new Error('expected the call to throw');
}

/** A shared instruction file with user prose before and after the region. */
function file(body: string): string {
  return `# Team notes\n\nSome user prose.\n\n${regionBeginMarker(ID)}\n${body}${regionEndMarker(ID)}\n\nMore user prose.\n`;
}

describe('region markers and the body range', () => {
  it('parses one well-formed pair and returns the exact body between the markers', () => {
    const parsed = parseRegionText(file('## House style\n\nAn older instruction.\n'), SUBJECT);
    expect(parsed.bom).toBe('');
    expect(parsed.regions).toHaveLength(1);
    const [span] = parsed.regions;
    expect(span?.id).toBe(ID);
    expect(span?.beginLine).toBe(5);
    expect(span?.endLine).toBe(9);
    expect(regionBody(parsed, ID)).toBe('## House style\n\nAn older instruction.\n');
  });

  it('treats two adjacent marker lines as an empty body', () => {
    const text = `${regionBeginMarker(ID)}\n${regionEndMarker(ID)}\n`;
    const parsed = parseRegionText(text, SUBJECT);
    expect(regionBody(parsed, ID)).toBe('');
    expect(parsed.regions[0]?.bodyStart).toBe(parsed.regions[0]?.bodyEnd);
  });

  it('parses several disjoint regions with different ids in document order', () => {
    const text = [
      regionBeginMarker('alpha'),
      'a',
      regionEndMarker('alpha'),
      'between',
      regionBeginMarker('beta'),
      'b',
      regionEndMarker('beta'),
      '',
    ].join('\n');
    const parsed = parseRegionText(text, SUBJECT);
    expect(parsed.regions.map((span) => span.id)).toEqual(['alpha', 'beta']);
    expect(regionBody(parsed, 'alpha')).toBe('a\n');
    expect(regionBody(parsed, 'beta')).toBe('b\n');
  });

  it('accepts a marker on the last line with no trailing newline', () => {
    const text = `${regionBeginMarker(ID)}\nbody\n${regionEndMarker(ID)}`;
    const parsed = parseRegionText(text, SUBJECT);
    expect(regionBody(parsed, ID)).toBe('body\n');
  });

  it('splits a leading BOM off the scanned text and keeps it for the write', () => {
    const text = `\uFEFF${file('body\n')}`;
    const parsed = parseRegionText(text, SUBJECT);
    expect(parsed.bom).toBe('\uFEFF');
    expect(parsed.text.startsWith('\uFEFF')).toBe(false);
    expect(regionBody(parsed, ID)).toBe('body\n');
  });
});

describe('malformed region files name the 1-based line', () => {
  it('refuses a begin without an end', () => {
    const error = captured(() => parseRegionText(`${regionBeginMarker(ID)}\nbody\n`, SUBJECT));
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.subject).toBe(SUBJECT);
    expect(error.message).toContain('line 1');
    expect(error.message).toContain('without a matching end marker');
  });

  it('refuses an end without a begin', () => {
    const error = captured(() => parseRegionText(`pre\n${regionEndMarker(ID)}\n`, SUBJECT));
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('line 2');
    expect(error.message).toContain('without a matching begin marker');
  });

  it('refuses a duplicate id, naming the second begin', () => {
    const text = [
      regionBeginMarker(ID),
      'one',
      regionEndMarker(ID),
      regionBeginMarker(ID),
      'two',
      regionEndMarker(ID),
      '',
    ].join('\n');
    const error = captured(() => parseRegionText(text, SUBJECT));
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('line 4');
    expect(error.message).toContain('already appears on line 1');
  });

  it('refuses a nested region, naming the inner begin', () => {
    const text = [
      regionBeginMarker('outer'),
      regionBeginMarker('inner'),
      'x',
      regionEndMarker('inner'),
      regionEndMarker('outer'),
      '',
    ].join('\n');
    const error = captured(() => parseRegionText(text, SUBJECT));
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('line 2');
    expect(error.message).toContain('inside the body of region "outer"');
  });

  it('refuses an end marker whose id does not match the open region', () => {
    const text = `${regionBeginMarker('alpha')}\nx\n${regionEndMarker('beta')}\n`;
    const error = captured(() => parseRegionText(text, SUBJECT));
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('line 3');
    expect(error.message).toContain('the open region is "alpha"');
  });

  it('refuses a marker with leading whitespace', () => {
    const error = captured(() => parseRegionText(`  ${regionBeginMarker(ID)}\n`, SUBJECT));
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('line 1');
    expect(error.message).toContain('not a valid region marker');
  });

  it('refuses a line that contains the prefix but is not a marker', () => {
    const error = captured(() =>
      parseRegionText(`text ${regionBeginMarker(ID)} trailing\n`, SUBJECT),
    );
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('line 1');
    expect(error.message).toContain('not a valid region marker');
  });

  it('refuses an id outside the lower-kebab grammar', () => {
    const error = captured(() => parseRegionText('<!-- farna:begin Not-Kebab -->\n', SUBJECT));
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('line 1');
  });

  it('refuses an id longer than 64 characters', () => {
    const longId = 'a'.repeat(65);
    const error = captured(() =>
      parseRegionText(`${regionBeginMarker(longId)}\n${regionEndMarker(longId)}\n`, SUBJECT),
    );
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('line 1');
  });

  it('refuses a CRLF file and names the first line that ends in CR', () => {
    const error = captured(() =>
      parseRegionText(`first\r\n${regionBeginMarker(ID)}\r\nbody\r\n`, SUBJECT),
    );
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('line 1 ends in CR');
    expect(error.action).toContain('.gitattributes');
  });

  it('refuses a non-UTF-8 file with the decoder byte offset', () => {
    const bytes = new Uint8Array([0x23, 0x20, 0xff, 0x0a]);
    const error = captured(() => parseRegionBytes(bytes, SUBJECT));
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('not valid UTF-8');
  });

  it('refuses a region id the plan does not know', () => {
    const text = `${regionBeginMarker('foreign')}\nx\n${regionEndMarker('foreign')}\n`;
    const error = captured(() => parseManagedRegionText(text, SUBJECT, [ID]));
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('line 1');
    expect(error.message).toContain('which this plan does not know');
  });

  it('refuses an unknown id through the bytes entry point the pipeline uses', () => {
    const bytes = Buffer.from(
      `${regionBeginMarker('foreign')}\nx\n${regionEndMarker('foreign')}\n`,
    );
    const error = captured(() => parseManagedRegionBytes(bytes, SUBJECT, [ID]));
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('which this plan does not know');
  });

  it('refuses non-UTF-8 through the bytes entry point', () => {
    const error = captured(() =>
      parseManagedRegionBytes(new Uint8Array([0x23, 0xff]), SUBJECT, [ID]),
    );
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('not valid UTF-8');
  });
});

describe('the merge writes only the region', () => {
  it('creates a marker pair and the body when the file is absent', () => {
    expect(mergeRegionText(undefined, ID, 'body', SUBJECT, { owned: false, adopt: false })).toBe(
      `${regionBeginMarker(ID)}\nbody\n${regionEndMarker(ID)}\n`,
    );
  });

  it('creates an adjacent marker pair for an empty body', () => {
    expect(mergeRegionText(undefined, ID, '', SUBJECT, { owned: true, adopt: false })).toBe(
      `${regionBeginMarker(ID)}\n${regionEndMarker(ID)}\n`,
    );
  });

  it('replaces the body and preserves every byte outside it, including a BOM', () => {
    const existing = `\uFEFF${file('## House style\n\nAn older instruction.\n')}`;
    const merged = mergeRegionText(
      existing,
      ID,
      '## House style\n\nWrite the smallest change.\n',
      SUBJECT,
      {
        owned: true,
        adopt: false,
      },
    );
    expect(merged.startsWith('\uFEFF# Team notes\n')).toBe(true);
    const before = existing.indexOf(regionBeginMarker(ID));
    const mergedBefore = merged.indexOf(regionBeginMarker(ID));
    expect(merged.slice(0, mergedBefore)).toBe(existing.slice(0, before));
    const after = existing.indexOf(regionEndMarker(ID));
    const mergedAfter = merged.indexOf(regionEndMarker(ID));
    expect(merged.slice(mergedAfter)).toBe(existing.slice(after));
    expect(merged).toContain('Write the smallest change.');
    expect(merged).not.toContain('An older instruction.');
  });

  it('preserves a file with no final newline', () => {
    const existing = `${regionBeginMarker(ID)}\nold\n${regionEndMarker(ID)}\npost`;
    const merged = mergeRegionText(existing, ID, 'new', SUBJECT, { owned: true, adopt: false });
    expect(merged.endsWith('post')).toBe(true);
    expect(merged).toBe(`${regionBeginMarker(ID)}\nnew\n${regionEndMarker(ID)}\npost`);
  });

  it('refuses an unrecorded marked file without --adopt and carries the block as a detail', () => {
    const error = captured(() =>
      mergeRegionText(file('old\n'), ID, 'new', SUBJECT, { owned: false, adopt: false }),
    );
    const detail = regionBlock(ID, 'new\n');
    expect(error.code).toBe('F007_DRIFT');
    expect(error.subject).toBe(SUBJECT);
    // The block is structured guidance, never a JSON-quoted fragment of the
    // single-line message.
    expect(error.message).not.toContain(JSON.stringify(detail));
    expect(error.message).toContain(ID);
    expect(error.message).toContain('not recorded in the committed lockfile');
    expect(error.detail).toBe(detail);
    expect(error.action).toContain('generate --adopt');
    const rendered = error.format().split('\n');
    const begin = rendered.indexOf(`  ${regionBeginMarker(ID)}`);
    expect(begin).toBeGreaterThan(0);
    expect(rendered.slice(begin, begin + 3)).toEqual([
      `  ${regionBeginMarker(ID)}`,
      '  new',
      `  ${regionEndMarker(ID)}`,
    ]);
    // The block ends with a newline; the human surface drops exactly that one,
    // so it ends on the end marker rather than an indent-only line.
    const formatted = error.format().split('\n');
    expect(formatted.at(-1)).toBe(`  ${regionEndMarker(ID)}`);
    expect(formatted.every((line) => line === '' || line.trim() !== '')).toBe(true);
  });

  it('appends one blank line and the marker pair to an unmarked file on adopt', () => {
    const existing = '# Notes\n';
    const merged = mergeRegionText(existing, ID, 'body', SUBJECT, { owned: false, adopt: true });
    expect(merged).toBe(`${existing}\n${regionBlock(ID, 'body')}`);
    expect(merged.startsWith('# Notes\n\n')).toBe(true);
  });

  it('appends one blank line to an unmarked file with no final newline', () => {
    const merged = mergeRegionText('# Notes', ID, 'body', SUBJECT, { owned: false, adopt: true });
    expect(merged).toBe(`# Notes\n\n${regionBlock(ID, 'body')}`);
  });

  it('replaces the body of a marked file on adopt without a record', () => {
    const merged = mergeRegionText(file('old\n'), ID, 'new', SUBJECT, {
      owned: false,
      adopt: true,
    });
    expect(merged).toContain('new');
    expect(merged).not.toContain('old');
    expect(merged).toContain('Some user prose.');
  });

  it('refuses a malformed file before assembling any text', () => {
    const error = captured(() =>
      mergeRegionText(`${regionBeginMarker(ID)}\nbody\n`, ID, 'new', SUBJECT, {
        owned: true,
        adopt: true,
      }),
    );
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('line 1');
  });

  it('refuses a file that carries an unknown region id', () => {
    const text = `${regionBeginMarker('foreign')}\nx\n${regionEndMarker('foreign')}\n`;
    const error = captured(() =>
      mergeRegionText(text, ID, 'new', SUBJECT, { owned: true, adopt: true }),
    );
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('which this plan does not know');
  });
});

describe('region body normalisation and the stripped orphan', () => {
  it('adds exactly one newline when the rendered body has none', () => {
    expect(normaliseRegionBody('a')).toBe('a\n');
    expect(normaliseRegionBody('a\n')).toBe('a\n');
    expect(normaliseRegionBody('a\n\n')).toBe('a\n\n');
    expect(normaliseRegionBody('')).toBe('');
  });

  it('strips the marker pair and body and keeps the surrounding bytes', () => {
    const text = `pre\n${regionBeginMarker(ID)}\nbody\n${regionEndMarker(ID)}\npost\n`;
    const parsed = parseRegionText(text, SUBJECT);
    const stripped = stripRegion(parsed, ID);
    expect(stripped).toEqual({ text: 'pre\npost\n', remaining: true });
  });

  it('reports nothing remaining when only the region was in the file', () => {
    const parsed = parseRegionText(regionBlock(ID, 'body'), SUBJECT);
    expect(stripRegion(parsed, ID)).toEqual({ text: '', remaining: false });
  });

  it('keeps a BOM when the region is stripped', () => {
    const parsed = parseRegionText(`\uFEFF${regionBlock(ID, 'body')}`, SUBJECT);
    expect(stripRegion(parsed, ID)).toEqual({ text: '\uFEFF', remaining: false });
  });

  it('returns undefined when the region is already absent', () => {
    const parsed = parseRegionText('plain\n', SUBJECT);
    expect(stripRegion(parsed, ID)).toBeUndefined();
  });
});

describe('the rendered body and the key', () => {
  it('refuses a rendered body that carries a marker line', () => {
    const error = captured(() =>
      assertNoRegionMarkers(`rule\n${regionBeginMarker(ID)}\n`, SUBJECT),
    );
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.message).toContain('line 2');
    expect(error.message).toContain('contains a region marker');
  });

  it('accepts a rendered body with no marker', () => {
    expect(() => assertNoRegionMarkers('## House style\n\nText.\n', SUBJECT)).not.toThrow();
  });

  it('maps the instruction file to its region id and nothing else', () => {
    expect(regionIdOf('CLAUDE.md')).toBe(ID);
    expect(regionIdOf('AGENTS.md')).toBeUndefined();
    expect(regionIdOf('.claude/agents/builder.md')).toBeUndefined();
  });

  it('keys two regions of one file separately', () => {
    expect(regionEntryKey('CLAUDE.md', 'alpha')).not.toBe(regionEntryKey('CLAUDE.md', 'beta'));
    expect(regionEntryKey('CLAUDE.md', 'alpha')).toBe('CLAUDE.md#region:alpha');
  });
});
