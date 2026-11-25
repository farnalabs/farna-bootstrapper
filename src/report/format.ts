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

/**
 * The run-level paths (the lockfile, and any orphan whose recording target is no
 * longer configured) belong to no target, so they follow the target sections
 * under their own heading rather than being attributed to one of them.
 */
function runLevelLines(
  files: readonly { path: string; status: string }[],
  removed: readonly { path: string; status: string }[],
): string[] {
  if (files.length === 0 && removed.length === 0) {
    return [];
  }
  const lines = ['  run-level'];
  for (const file of files) {
    lines.push(`  ${file.status.padEnd(STATUS_WIDTH)} ${escapeControlCharacters(file.path)}`);
  }
  for (const orphan of removed) {
    lines.push(`  ${orphan.status.padEnd(STATUS_WIDTH)} ${escapeControlCharacters(orphan.path)}`);
  }
  return lines;
}

export function formatGenerate(result: GenerateResult): string {
  const lines = ['farna-bootstrapper generate'];
  for (const target of result.targets) {
    const pending = target.files.filter(
      (file) => file.status === 'would-write' || file.status === 'written',
    ).length;
    const unchanged = target.files.length - pending;
    const removals = target.removed.filter(
      (entry) => entry.status === 'removed' || entry.status === 'would-remove',
    ).length;
    const updates = target.removed.filter(
      (entry) => entry.status === 'updated' || entry.status === 'would-update',
    ).length;
    const updated = updates === 0 ? '' : `, ${updates}${result.dryRun ? ' would be' : ''} updated`;
    // A dry-run says how many files it WOULD write, never the size of the plan:
    // "would write 3 file(s)" when every file already matches is a false claim.
    // Each target's summary counts only that target's files.
    const summary = result.dryRun
      ? `would write ${pending} file(s), ${unchanged} unchanged, ${removals} would be removed${updated}`
      : `managed ${pending} file(s), ${unchanged} unchanged, ${removals} removed${updated}`;
    lines.push(`  target ${target.target} (${modeLabel(target.mode, target.activePersona)})`);
    const notLive = notLiveLine(target.mode, target.notLive);
    if (notLive !== undefined) {
      lines.push(notLive);
    }
    lines.push(`  personas ${target.personas.map(escapeControlCharacters).join(', ')}`);
    lines.push(`  ${summary}`);
    for (const file of target.files) {
      lines.push(`  ${file.status.padEnd(STATUS_WIDTH)} ${escapeControlCharacters(file.path)}`);
    }
    for (const orphan of target.removed) {
      lines.push(`  ${orphan.status.padEnd(STATUS_WIDTH)} ${escapeControlCharacters(orphan.path)}`);
    }
  }
  lines.push(...runLevelLines(result.files, result.removed));
  lines.push(...warningLines(result.warnings));
  return `${lines.join('\n')}\n`;
}

export function formatCheck(result: CheckResult): string {
  const lines = ['farna-bootstrapper check'];
  for (const target of result.targets) {
    lines.push(`  target ${target.target} (${modeLabel(target.mode, target.activePersona)})`);
    const notLive = notLiveLine(target.mode, target.notLive);
    if (notLive !== undefined) {
      lines.push(notLive);
    }
    if (target.drift.length === 0) {
      lines.push(`  ${target.checked.length} managed file(s) match a fresh render`);
    } else {
      lines.push(`  ${target.drift.length} drifted path(s)`);
      for (const item of target.drift) {
        lines.push(
          `  ${item.kind.padEnd(STATUS_WIDTH)} ${escapeControlCharacters(item.path)} (${item.detail})`,
        );
      }
    }
  }
  // A run-level path is printed only under the status it actually has: a
  // matched comparison, a drift finding, or a deliberate skip. A pending
  // version 1 lockfile never appears as "checked".
  if (result.checked.length > 0 || result.drift.length > 0 || result.pending.length > 0) {
    lines.push('  run-level');
    if (result.checked.length > 0) {
      lines.push(`  ${result.checked.length} managed file(s) match a fresh render`);
    }
    if (result.drift.length > 0) {
      lines.push(`  ${result.drift.length} drifted path(s)`);
      for (const item of result.drift) {
        lines.push(
          `  ${item.kind.padEnd(STATUS_WIDTH)} ${escapeControlCharacters(item.path)} (${item.detail})`,
        );
      }
    }
    for (const item of result.pending) {
      lines.push(
        `  ${'pending'.padEnd(STATUS_WIDTH)} ${escapeControlCharacters(item.path)} (${item.detail})`,
      );
    }
  }
  lines.push(...warningLines(result.warnings));
  lines.push('', result.ok ? 'check: clean' : 'check: drift');
  return `${lines.join('\n')}\n`;
}

/**
 * The validation report. Every check listed here ran to completion: `doctor`
 * fails at the first error and never prints a partial success, so a check name
 * in this section is evidence the check did not fail. Each target has its own
 * section, because its mode, live persona and counts are properties of that
 * target rather than of the run.
 */
export function formatDoctor(result: DoctorResult): string {
  const lines = ['farna-bootstrapper doctor'];
  lines.push(`  source    ${escapeControlCharacters(result.configPath)}`);
  for (const target of result.targets) {
    lines.push(
      `  target    ${escapeControlCharacters(target.target)} (${modeLabel(target.mode, target.activePersona)})`,
    );
    lines.push(`  personas  ${target.counts.personas} in source, ${target.counts.live} live`);
    const notLive = notLiveLine(target.mode, target.notLive);
    if (notLive !== undefined) {
      lines.push(`    ${notLive.trimStart()}`);
    }
    lines.push(`  checks    ${target.checks.length} ok`);
  }
  lines.push(`  warnings  ${result.warnings.length}`);

  lines.push('', 'checks');
  for (const target of result.targets) {
    lines.push(`  ${escapeControlCharacters(target.target)}`);
    for (const check of target.checks) {
      lines.push(`    ok  ${check.name.padEnd(36)}${escapeControlCharacters(check.detail)}`);
    }
  }

  lines.push('', 'personas');
  for (const target of result.targets) {
    lines.push(`  ${escapeControlCharacters(target.target)}`);
    for (const persona of target.personas) {
      lines.push(`    ${escapeControlCharacters(persona.id)}`);
      lines.push(`      chain      ${persona.chain.map(escapeControlCharacters).join(' -> ')}`);
      lines.push(`      mode       ${persona.mode ?? 'subagent (default)'}`);
      lines.push(
        `      model      ${persona.model === null ? '<none>' : escapeControlCharacters(persona.model)}`,
      );
      for (const resource of persona.resources) {
        const from =
          resource.fromPersona === persona.id
            ? ''
            : ` (from ${escapeControlCharacters(resource.fromPersona)}, rank ${resource.rank})`;
        lines.push(
          `      resource   ${`${resource.kind}/${resource.id}`.padEnd(28)}${escapeControlCharacters(resource.path)}${from}`,
        );
      }
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
