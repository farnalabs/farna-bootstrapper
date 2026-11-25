import { describe, expect, it } from 'vitest';
import { failureObject, unexpectedFailureObject } from '../../src/cli/program.js';
import { DRIFT_CODE, EXIT, EXIT_BY_CODE } from '../../src/core/constants.js';
import { FarnaError } from '../../src/core/errors.js';

describe('the diagnostic exit table', () => {
  it('has no F007 entry: drift is a result, not an exception', () => {
    expect(Object.keys(EXIT_BY_CODE)).not.toContain(DRIFT_CODE);
    expect(DRIFT_CODE).toBe('F007_DRIFT');
  });

  it('gives drift its own constant, separate from every exception code', () => {
    expect(EXIT.drift).toBe(1);
    expect(EXIT.invalidConfig).toBe(1);
    // F008 is a containment failure, not drift; it has its own exit and does
    // not borrow EXIT.drift.
    expect(EXIT.declaredNotEmitted).toBe(4);
    expect(EXIT_BY_CODE.F008_DECLARED_NOT_EMITTED).toBe(4);
    expect(EXIT_BY_CODE.F008_DECLARED_NOT_EMITTED).not.toBe(EXIT.drift);
  });

  it('maps every exception code to its documented exit', () => {
    expect(EXIT_BY_CODE.F001_INVALID_CONFIG).toBe(1);
    expect(EXIT_BY_CODE.F005_CONFLICT).toBe(2);
    expect(EXIT_BY_CODE.F011_PERMISSION_UNMAPPED).toBe(3);
    expect(EXIT_BY_CODE.F008_DECLARED_NOT_EMITTED).toBe(4);
    expect(EXIT_BY_CODE.F009_RENDER_FAILED).toBe(5);
    expect(EXIT_BY_CODE.F010_RENDERER_MISMATCH).toBe(5);
    expect(EXIT_BY_CODE.F012_WRITE_FAILED).toBe(5);
  });
});

describe('a diagnostic detail block', () => {
  it('formats exactly as before when there is no detail', () => {
    const error = new FarnaError('F001_INVALID_CONFIG', 'the message', {
      subject: 'a.ts',
      action: 'fix it',
    });
    expect(error.detail).toBeUndefined();
    expect(error.format()).toBe('F001_INVALID_CONFIG a.ts\n  the message\n  fix it');
  });

  it('indents every line of a three-line detail and escapes a control character inside a line', () => {
    const error = new FarnaError('F001_INVALID_CONFIG', 'the message', {
      action: 'fix it',
      detail: 'first\nsecond\tline\nthird\u001bX',
    });
    expect(error.format()).toBe(
      'F001_INVALID_CONFIG\n  the message\n  fix it\n  first\n  second\\u0009line\n  third\\u001bX',
    );
  });

  it('carries the detail in the failure object, and null when there is none', () => {
    const withDetail = new FarnaError('F001_INVALID_CONFIG', 'the message', { detail: 'a\nb' });
    expect(failureObject('generate', withDetail)).toMatchObject({ detail: 'a\nb' });
    const withoutDetail = new FarnaError('F001_INVALID_CONFIG', 'the message');
    expect(failureObject('generate', withoutDetail)).toMatchObject({ detail: null });
  });

  it('prints no trailing indent-only line for a block ending in a newline, but keeps it in JSON', () => {
    const error = new FarnaError('F001_INVALID_CONFIG', 'the message', { detail: 'a\nb\n' });
    expect(error.format()).toBe('F001_INVALID_CONFIG\n  the message\n  a\n  b');
    expect(failureObject('generate', error)).toMatchObject({ detail: 'a\nb\n' });
  });

  it('carries detail: null on an untyped failure', () => {
    expect(unexpectedFailureObject('generate', 'boom')).toMatchObject({ detail: null });
  });
});
