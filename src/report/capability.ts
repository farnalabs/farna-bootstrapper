import { type Capability, PRODUCT_VERSION } from '../core/constants.js';
import { escapeControlCharacters } from '../core/text.js';
import {
  type CapabilityCell,
  type CapabilitySnapshot,
  emissionGlyph,
  emissionWord,
  MATRIX_CAPABILITIES,
  type PermissionKeyCell,
  permissionCategories,
  SNAPSHOT,
  type TargetStatus,
} from '../matrix/snapshot.js';
import type { PermissionCategory } from '../permissions/permissions.js';

/**
 * The machine-readable capability report. It is built from the committed
 * snapshot and carries every value the human table prints, so `--json` is the
 * same claim in a shape a pipeline can consume.
 */
export type CapabilityReport = {
  schemaVersion: 1;
  command: 'report';
  ok: true;
  exitCode: 0;
  renderer: { name: string; version: string };
  targets: Array<{
    id: string;
    status: TargetStatus;
    agentReach: 'primary' | 'subagent';
    capabilities: Record<Capability, CapabilityCell>;
    permissionKeys: Record<PermissionCategory, PermissionKeyCell>;
  }>;
};

export function buildCapabilityReport(snapshot: CapabilitySnapshot = SNAPSHOT): CapabilityReport {
  return {
    schemaVersion: 1,
    command: 'report',
    ok: true,
    exitCode: 0,
    renderer: { ...snapshot.renderer },
    targets: snapshot.targets.map((target) => ({
      id: target.id,
      status: target.status,
      agentReach: target.agentReach,
      // A copy, never the snapshot object: a caller must not be able to mutate
      // the measured record through a report it was handed.
      capabilities: Object.fromEntries(
        MATRIX_CAPABILITIES.map((capability) => [capability, { ...target.cells[capability] }]),
      ) as Record<Capability, CapabilityCell>,
      permissionKeys: Object.fromEntries(
        permissionCategories().map((key) => [key, { ...target.permissionKeys[key] }]),
      ) as Record<PermissionCategory, PermissionKeyCell>,
    })),
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width);
}

const CAPABILITY_WIDTH = 14;
const TARGET_WIDTH = 17;
const AXIS_AGENT_WIDTH = 6;
const AXIS_WORKSPACE_WIDTH = 11;

/** The non-native axes of a cell, each with its glyph and word. */
function nonNativeAxes(cell: CapabilityCell): string {
  const axes: string[] = [];
  if (cell.agent !== 'native') {
    axes.push(`agent ${emissionGlyph(cell.agent)} ${emissionWord(cell.agent)}`);
  }
  if (cell.workspace !== 'native') {
    axes.push(`workspace ${emissionGlyph(cell.workspace)} ${emissionWord(cell.workspace)}`);
  }
  return axes.join(', ');
}

function capabilityTable(report: CapabilityReport): string[] {
  const lines: string[] = ['capability matrix'];
  const header = report.targets.map((target) => pad(target.id, TARGET_WIDTH)).join('');
  lines.push(`  ${pad('capability', CAPABILITY_WIDTH)}${header}`.trimEnd());
  const axisHeader = report.targets
    .map(() => `${pad('agent', AXIS_AGENT_WIDTH)}${pad('workspace', AXIS_WORKSPACE_WIDTH)}`)
    .join('');
  lines.push(`  ${pad('', CAPABILITY_WIDTH)}${axisHeader}`.trimEnd());
  for (const capability of MATRIX_CAPABILITIES) {
    const cells = report.targets
      .map((target) => {
        const cell = target.capabilities[capability];
        return `${pad(emissionGlyph(cell.agent), AXIS_AGENT_WIDTH)}${pad(emissionGlyph(cell.workspace), AXIS_WORKSPACE_WIDTH)}`;
      })
      .join('');
    lines.push(`  ${pad(capability, CAPABILITY_WIDTH)}${cells}`.trimEnd());
  }

  lines.push('', 'consequences');
  let anyConsequence = false;
  for (const target of report.targets) {
    lines.push(`  ${escapeControlCharacters(target.id)}`);
    for (const capability of MATRIX_CAPABILITIES) {
      const cell = target.capabilities[capability];
      const axes = nonNativeAxes(cell);
      if (axes === '') {
        continue;
      }
      anyConsequence = true;
      lines.push(`    ${pad(capability, 12)}${axes}`);
      if (cell.consequence !== null) {
        lines.push(`      ${escapeControlCharacters(cell.consequence)}`);
      }
    }
  }
  if (!anyConsequence) {
    lines.push('  none: every cell is native');
  }
  return lines;
}

function permissionTable(report: CapabilityReport): string[] {
  const keys = permissionCategories();
  const lines: string[] = ['', 'permission keys (per persona, agent mode)'];
  const header = report.targets.map((target) => pad(target.id, 13)).join('');
  lines.push(`  ${pad('key', 12)}${header}`.trimEnd());
  for (const key of keys) {
    const cells = report.targets
      .map((target) => pad(emissionGlyph(target.permissionKeys[key].emission), 13))
      .join('');
    lines.push(`  ${pad(key, 12)}${cells}`.trimEnd());
  }

  lines.push('', 'permission consequences');
  let anyConsequence = false;
  for (const target of report.targets) {
    const entries: string[] = [];
    for (const key of keys) {
      const cell = target.permissionKeys[key];
      if (cell.emission === 'native') {
        continue;
      }
      anyConsequence = true;
      const code = cell.code === null ? '' : ` (${cell.code})`;
      entries.push(
        `    ${pad(key, 10)}${emissionGlyph(cell.emission)} ${emissionWord(cell.emission)}${code}`,
      );
      if (cell.consequence !== null) {
        entries.push(`      ${escapeControlCharacters(cell.consequence)}`);
      }
    }
    if (entries.length > 0) {
      lines.push(`  ${escapeControlCharacters(target.id)}`, ...entries);
    }
  }
  if (!anyConsequence) {
    lines.push('  none: every permission key is native');
  }
  return lines;
}

/**
 * The human table. `unknown` renders as `[?] not measured` and is never
 * printed as `[x]`; every dropped, emulated and unknown cell prints its
 * consequence, so the table never becomes a bare tick a reader can misread.
 */
export function formatCapabilityReport(report: CapabilityReport): string {
  const lines: string[] = [
    `farna-bootstrapper report ${PRODUCT_VERSION}`,
    `  renderer ${report.renderer.name} ${report.renderer.version}`,
    '  cells    native [x]  emulated [~]  dropped [ ]  not measured [?]',
    '  note     the committed measured matrix; the harness remains the authority on runtime behaviour',
    '',
    ...capabilityTable(report),
    ...permissionTable(report),
    '',
    'labels',
    ...report.targets.map(
      (target) =>
        `  ${pad(target.id, 12)}${pad(escapeControlCharacters(target.status), 12)}reach ${target.agentReach}`,
    ),
    '',
    'report: ok',
  ];
  return `${lines.join('\n')}\n`;
}
