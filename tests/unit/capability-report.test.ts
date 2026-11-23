import { describe, expect, it } from 'vitest';
import { SUPPORTED_TARGETS } from '../../src/core/constants.js';
import {
  type CapabilitySnapshot,
  emissionGlyph,
  emissionWord,
  MATRIX_CAPABILITIES,
  permissionCategories,
  SNAPSHOT,
  verifySnapshot,
} from '../../src/matrix/snapshot.js';
import { RENDERER_PIN } from '../../src/render/upstream.js';
import { buildCapabilityReport, formatCapabilityReport } from '../../src/report/capability.js';

/** Every emission value used anywhere in the report, capabilities and keys alike. */
function emissions(report: ReturnType<typeof buildCapabilityReport>): Set<string> {
  const values = new Set<string>();
  for (const target of report.targets) {
    for (const capability of MATRIX_CAPABILITIES) {
      values.add(target.capabilities[capability].agent);
      values.add(target.capabilities[capability].workspace);
    }
    for (const key of permissionCategories()) {
      values.add(target.permissionKeys[key].emission);
    }
  }
  return values;
}

function cloneSnapshot(): CapabilitySnapshot {
  return JSON.parse(JSON.stringify(SNAPSHOT)) as CapabilitySnapshot;
}

function expectMatrixRefusal(run: () => void): void {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code: 'F010_RENDERER_MISMATCH' });
    return;
  }
  throw new Error('expected the snapshot to be refused with F010');
}

describe('the capability snapshot', () => {
  it('has exactly one row for every supported target and every capability', () => {
    expect(SNAPSHOT.targets.map((target) => target.id)).toEqual([...SUPPORTED_TARGETS]);
    for (const target of SNAPSHOT.targets) {
      expect(Object.keys(target.cells).sort()).toEqual([...MATRIX_CAPABILITIES].sort());
      expect(Object.keys(target.permissionKeys).sort()).toEqual([...permissionCategories()].sort());
    }
  });

  it('records the pinned renderer version', () => {
    expect(SNAPSHOT.renderer).toEqual({ name: RENDERER_PIN.name, version: RENDERER_PIN.version });
    expect(() => verifySnapshot(SNAPSHOT, RENDERER_PIN.version)).not.toThrow();
  });

  it('refuses a snapshot measured against a different renderer, with F010', () => {
    expectMatrixRefusal(() => verifySnapshot(SNAPSHOT, '0.0.0-other'));
  });

  it('refuses an unmeasured cell on a promised target', () => {
    const snapshot = cloneSnapshot();
    const target = snapshot.targets[0];
    if (target === undefined) {
      throw new Error('expected a target');
    }
    target.cells.rule.agent = 'unknown';
    expectMatrixRefusal(() => verifySnapshot(snapshot));
  });

  it('allows an unknown cell on an unverified target', () => {
    const snapshot = cloneSnapshot();
    const target = snapshot.targets[0];
    if (target === undefined) {
      throw new Error('expected a target');
    }
    target.status = 'unverified';
    target.cells.rule.agent = 'unknown';
    expect(() => verifySnapshot(snapshot)).not.toThrow();
  });

  it('gives every non-native capability cell a consequence', () => {
    for (const target of SNAPSHOT.targets) {
      for (const capability of MATRIX_CAPABILITIES) {
        const cell = target.cells[capability];
        const nonNative = cell.agent !== 'native' || cell.workspace !== 'native';
        if (!nonNative) {
          continue;
        }
        expect(cell.consequence, `${target.id}/${capability}`).not.toBeNull();
      }
    }
  });
});

describe('emission rendering', () => {
  it('gives each value exactly one glyph and one word', () => {
    expect(emissionGlyph('native')).toBe('[x]');
    expect(emissionGlyph('emulated')).toBe('[~]');
    expect(emissionGlyph('dropped')).toBe('[ ]');
    expect(emissionGlyph('unknown')).toBe('[?]');
    expect(emissionWord('native')).toBe('native');
    expect(emissionWord('emulated')).toBe('emulated');
    expect(emissionWord('dropped')).toBe('dropped');
    expect(emissionWord('unknown')).toBe('not measured');
  });
});

describe('the capability report', () => {
  it('reports every supported target and every capability', () => {
    const report = buildCapabilityReport();
    expect(report.targets.map((target) => target.id)).toEqual([...SUPPORTED_TARGETS]);
    for (const target of report.targets) {
      expect(Object.keys(target.capabilities).sort()).toEqual([...MATRIX_CAPABILITIES].sort());
      expect(Object.keys(target.permissionKeys).sort()).toEqual([...permissionCategories()].sort());
    }
  });

  it('uses all four emission values in the measured data', () => {
    expect([...emissions(buildCapabilityReport())].sort()).toEqual([
      'dropped',
      'emulated',
      'native',
      'unknown',
    ]);
  });

  it('renders an unknown cell as [?] and never as a tick', () => {
    const text = formatCapabilityReport(buildCapabilityReport());
    // The bare `mcp` permission key is unmeasured on both OpenCode targets.
    const permissionSection = text.slice(text.indexOf('permission keys'));
    const line = permissionSection.split('\n').find((entry) => entry.trimStart().startsWith('mcp'));
    expect(line).toBeDefined();
    expect(line).toMatch(/^\s+mcp\s+\[ \]\s+\[\?\]\s+\[\?\]\s*$/);
    expect(line).not.toContain('[x]');
    expect(text).toContain('[?] not measured');
  });

  it('prints every emission glyph and a consequence for each non-native cell', () => {
    const text = formatCapabilityReport(buildCapabilityReport());
    for (const glyph of ['[x]', '[~]', '[ ]', '[?]']) {
      expect(text).toContain(glyph);
    }
    expect(text).toContain('has no write category, so write is emitted as edit');
    expect(text).toContain('profile mode is not supported on claudecode in this release');
    expect(text).toContain('labels');
    expect(text).toContain('reach subagent');
    expect(text).toContain('report: ok');
  });

  it('builds a JSON report that does not share objects with the snapshot', () => {
    const report = buildCapabilityReport();
    const target = report.targets[0];
    if (target === undefined) {
      throw new Error('expected a target');
    }
    target.capabilities.rule.agent = 'unknown';
    expect(SNAPSHOT.targets[0]?.cells.rule.agent).toBe('native');
  });
});
