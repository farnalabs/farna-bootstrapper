import { describe, expect, it } from 'vitest';
import { DRIFT_CODE, EXIT, EXIT_BY_CODE } from '../../src/core/constants.js';

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
