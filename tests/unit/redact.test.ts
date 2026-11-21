import { describe, expect, it } from 'vitest';
import { redactRoot } from '../../src/cli/program.js';

describe('unexpected-error redaction', () => {
  it('strips a POSIX repository root from a raw filesystem message', () => {
    expect(redactRoot('ENOENT: no such file, open /work/repo/.farna/x', '/work/repo')).toBe(
      'ENOENT: no such file, open .farna/x',
    );
  });

  it('strips a Windows repository root with backslashes', () => {
    expect(redactRoot('EACCES: C:\\work\\repo\\.farna\\x', 'C:\\work\\repo')).toBe(
      'EACCES: .farna\\x',
    );
  });

  it('leaves a message with no root untouched', () => {
    expect(redactRoot('boom', '/work/repo')).toBe('boom');
  });
});
