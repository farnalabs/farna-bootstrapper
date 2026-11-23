import type { CheckResult } from '../cli/commands/check.js';
import type { DoctorResult } from '../cli/commands/doctor.js';
import type { GenerateResult } from '../cli/commands/generate.js';
import type { InitResult } from '../cli/commands/init.js';
import type { RenderMode } from '../core/constants.js';
import { escapeControlCharacters } from '../core/text.js';
import type { Warning } from './warnings.js';

/**
 * One column width for every status word the reports print. Two widths made the
 * columns misalign whenever a generate listed both a file and a removal.
 */
const STATUS_WIDTH = 12;

/**
 * The mode line names the active persona only in profile mode: in agent mode
 * every persona is live, and there is no selection to report.
 */
function modeLabel(mode: RenderMode, activePersona: string | null): string {
  return mode === 'profile' ? `profile mode, active ${activePersona ?? '<none>'}` : 'agent mode';
}

/**
 * Profile mode makes exactly one persona live. The others are resolved and
 * validated but not emitted; saying so is the difference between a deliberate
 * selection and a silent deactivation.
 */
function notLiveLine(mode: RenderMode, notLive: readonly string[]): string | undefined {
  if (mode !== 'profile' || notLive.length === 0) {
    return undefined;
  }
  return `  not live ${notLive.map(escapeControlCharacters).join(', ')}`;
}

function warningLines(warnings: readonly Warning[]): string[] {
  if (warnings.length === 0) {
    return [];
  }
  const lines = [`  warnings ${warnings.length}`];
  for (const entry of warnings) {
    lines.push(
      `  ${entry.code} ${entry.severity.padEnd(6)} ${escapeControlCharacters(entry.persona)}: ${escapeControlCharacters(entry.message)}`,
    );
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
  const removals = result.removed.filter(
    (entry) => entry.status === 'removed' || entry.status === 'would-remove',
  ).length;
  const updates = result.removed.filter(
    (entry) => entry.status === 'updated' || entry.status === 'would-update',
  ).length;
  const updated = updates === 0 ? '' : `, ${updates}${result.dryRun ? ' would be' : ''} updated`;
  // A dry-run says how many files it WOULD write, never the size of the plan:
  // "would write 3 file(s)" when every file already matches is a false claim.
  const summary = result.dryRun
    ? `would write ${pending} file(s), ${unchanged} unchanged, ${removals} would be removed${updated}`
    : `managed ${pending} file(s), ${unchanged} unchanged, ${removals} removed${updated}`;
  const lines = ['farna-bootstrapper generate'];
  lines.push(`  target ${result.target} (${modeLabel(result.mode, result.activePersona)})`);
  const notLive = notLiveLine(result.mode, result.notLive);
  if (notLive !== undefined) {
    lines.push(notLive);
  }
  lines.push(`  personas ${result.personas.map(escapeControlCharacters).join(', ')}`);
  lines.push(`  ${summary}`);
  for (const file of result.files) {
    lines.push(`  ${file.status.padEnd(STATUS_WIDTH)} ${escapeControlCharacters(file.path)}`);
  }
  for (const orphan of result.removed) {
    lines.push(`  ${orphan.status.padEnd(STATUS_WIDTH)} ${escapeControlCharacters(orphan.path)}`);
  }
  lines.push(...warningLines(result.warnings));
  return `${lines.join('\n')}\n`;
}

export function formatCheck(result: CheckResult): string {
  const lines = ['farna-bootstrapper check'];
  lines.push(`  target ${result.target} (${modeLabel(result.mode, result.activePersona)})`);
  const notLive = notLiveLine(result.mode, result.notLive);
  if (notLive !== undefined) {
    lines.push(notLive);
  }
  if (result.ok) {
    lines.push(`  ${result.checked.length} managed file(s) match a fresh render`);
    lines.push(...warningLines(result.warnings));
    lines.push('', 'check: clean');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`  ${result.drift.length} drifted path(s)`);
  for (const item of result.drift) {
    lines.push(
      `  ${item.kind.padEnd(STATUS_WIDTH)} ${escapeControlCharacters(item.path)} (${item.detail})`,
    );
  }
  lines.push(...warningLines(result.warnings));
  lines.push('', 'check: drift');
  return `${lines.join('\n')}\n`;
}

/**
 * The validation report. Every check listed here ran to completion: `doctor`
 * fails at the first error and never prints a partial success, so a check name
 * in this section is evidence the check did not fail.
 */
export function formatDoctor(result: DoctorResult): string {
  const lines = ['farna-bootstrapper doctor'];
  lines.push(`  source    ${escapeControlCharacters(result.configPath)}`);
  lines.push(
    `  target    ${escapeControlCharacters(result.target)} (${modeLabel(result.mode, result.activePersona)})`,
  );
  lines.push(`  personas  ${result.counts.personas} in source, ${result.counts.live} live`);
  const notLive = notLiveLine(result.mode, result.notLive);
  if (notLive !== undefined) {
    lines.push(notLive);
  }
  lines.push(`  checks    ${result.checks.length} ok`);
  lines.push(`  warnings  ${result.warnings.length}`);

  lines.push('', 'checks');
  for (const check of result.checks) {
    lines.push(`  ok  ${check.name.padEnd(36)}${escapeControlCharacters(check.detail)}`);
  }

  lines.push('', 'personas');
  for (const persona of result.personas) {
    lines.push(`  ${escapeControlCharacters(persona.id)}`);
    lines.push(`    chain      ${persona.chain.map(escapeControlCharacters).join(' -> ')}`);
    lines.push(`    mode       ${persona.mode ?? 'subagent (default)'}`);
    lines.push(
      `    model      ${persona.model === null ? '<none>' : escapeControlCharacters(persona.model)}`,
    );
    for (const resource of persona.resources) {
      const from =
        resource.fromPersona === persona.id
          ? ''
          : ` (from ${escapeControlCharacters(resource.fromPersona)}, rank ${resource.rank})`;
      lines.push(
        `    resource   ${`${resource.kind}/${resource.id}`.padEnd(28)}${escapeControlCharacters(resource.path)}${from}`,
      );
    }
  }

  if (result.warnings.length > 0) {
    lines.push('', 'warnings');
    for (const entry of result.warnings) {
      lines.push(
        `  ${entry.code} ${entry.severity.padEnd(6)} ${escapeControlCharacters(entry.persona)}: ${escapeControlCharacters(entry.message)}`,
      );
    }
  }

  lines.push('', 'doctor: ok');
  return `${lines.join('\n')}\n`;
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
