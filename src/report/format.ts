import type { CheckResult } from '../cli/commands/check.js';
import type { GenerateResult } from '../cli/commands/generate.js';
import type { InitResult } from '../cli/commands/init.js';

export function formatInit(result: InitResult): string {
  const lines = ['farna-bootstrapper init', `  created ${result.configPath}`];
  for (const path of result.created) {
    lines.push(`  + ${path}`);
  }
  lines.push('', result.nextStep);
  return `${lines.join('\n')}\n`;
}

export function formatGenerate(result: GenerateResult): string {
  const action = result.dryRun ? 'would write' : 'managed';
  const lines = [
    'farna-bootstrapper generate',
    `  target ${result.target} (agent mode)`,
    `  personas ${result.personas.join(', ')}`,
    `  ${action} ${result.files.length} file(s)`,
  ];
  for (const file of result.files) {
    lines.push(`  ${file.status.padEnd(10)} ${file.path}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatCheck(result: CheckResult): string {
  const lines = ['farna-bootstrapper check', `  target ${result.target} (agent mode)`];
  if (result.ok) {
    lines.push(`  ${result.checked.length} managed file(s) match a fresh render`);
    lines.push('', 'check: clean');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`  ${result.drift.length} drifted path(s)`);
  for (const item of result.drift) {
    lines.push(`  ${item.kind.padEnd(10)} ${item.path} (${item.detail})`);
  }
  lines.push('', 'check: drift');
  return `${lines.join('\n')}\n`;
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
