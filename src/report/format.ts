import type { CheckResult } from '../cli/commands/check.js';
import type { GenerateResult } from '../cli/commands/generate.js';
import type { InitResult } from '../cli/commands/init.js';
import type { RenderMode } from '../core/constants.js';
import type { Warning } from './warnings.js';

/**
 * The mode line names the active persona only in profile mode: in agent mode
 * every persona is live, and there is no selection to report.
 */
function modeLabel(mode: RenderMode, activePersona: string | null): string {
  return mode === 'profile' ? `profile mode, active ${activePersona ?? '<none>'}` : 'agent mode';
}

function warningLines(warnings: readonly Warning[]): string[] {
  if (warnings.length === 0) {
    return [];
  }
  const lines = [`  warnings ${warnings.length}`];
  for (const entry of warnings) {
    lines.push(`  ${entry.code} ${entry.severity.padEnd(6)} ${entry.persona}: ${entry.message}`);
  }
  return lines;
}

export function formatInit(result: InitResult): string {
  const lines = ['farna-bootstrapper init', `  created ${result.configPath}`];
  for (const path of result.created) {
    lines.push(`  + ${path}`);
  }
  for (const path of result.updated) {
    lines.push(`  ~ ${path}`);
  }
  lines.push('', result.nextStep);
  return `${lines.join('\n')}\n`;
}

export function formatGenerate(result: GenerateResult): string {
  const pending = result.files.filter(
    (file) => file.status === 'would-write' || file.status === 'written',
  ).length;
  const unchanged = result.files.length - pending;
  // A dry-run says how many files it WOULD write, never the size of the plan:
  // "would write 3 file(s)" when every file already matches is a false claim.
  const summary = result.dryRun
    ? `would write ${pending} file(s), ${unchanged} unchanged`
    : `managed ${pending} file(s), ${unchanged} unchanged`;
  const lines = [
    'farna-bootstrapper generate',
    `  target ${result.target} (${modeLabel(result.mode, result.activePersona)})`,
    `  personas ${result.personas.join(', ')}`,
    `  ${summary}`,
  ];
  for (const file of result.files) {
    lines.push(`  ${file.status.padEnd(10)} ${file.path}`);
  }
  for (const orphan of result.removed) {
    lines.push(`  ${orphan.status.padEnd(12)} ${orphan.path}`);
  }
  lines.push(...warningLines(result.warnings));
  return `${lines.join('\n')}\n`;
}

export function formatCheck(result: CheckResult): string {
  const lines = [
    'farna-bootstrapper check',
    `  target ${result.target} (${modeLabel(result.mode, result.activePersona)})`,
  ];
  if (result.ok) {
    lines.push(`  ${result.checked.length} managed file(s) match a fresh render`);
    lines.push(...warningLines(result.warnings));
    lines.push('', 'check: clean');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`  ${result.drift.length} drifted path(s)`);
  for (const item of result.drift) {
    lines.push(`  ${item.kind.padEnd(10)} ${item.path} (${item.detail})`);
  }
  lines.push(...warningLines(result.warnings));
  lines.push('', 'check: drift');
  return `${lines.join('\n')}\n`;
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
