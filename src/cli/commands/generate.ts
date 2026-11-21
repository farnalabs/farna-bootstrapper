import { join } from 'node:path';
import { commitFiles, currentBytes, type FileStatus } from '../../render/commit.js';
import type { RenderTarget } from '../../render/port.js';
import { prepareRender } from '../../render/prepare.js';
import type { Warning } from '../../report/warnings.js';

export type GenerateOptions = {
  cwd: string;
  dryRun: boolean;
};

export type GenerateResult = {
  ok: true;
  target: string;
  dryRun: boolean;
  personas: string[];
  files: Array<{ path: string; status: FileStatus | 'would-write' }>;
  warnings: Warning[];
};

/**
 * Render the source tree, verify containment, then write the verified set.
 * In dry-run mode nothing is written, and every path is compared with the
 * working tree so the plan distinguishes `unchanged` from `would-write`.
 */
export async function runGenerate(
  options: GenerateOptions,
  renderer: RenderTarget,
): Promise<GenerateResult> {
  const prepared = await prepareRender(options.cwd, renderer);
  const personas = prepared.source.personas.map((persona) => persona.id);

  if (options.dryRun) {
    const files: GenerateResult['files'] = [];
    for (const file of prepared.files) {
      const existing = await currentBytes(join(options.cwd, file.path));
      files.push({
        path: file.path,
        status: existing === file.bytes ? 'unchanged' : 'would-write',
      });
    }
    return {
      ok: true,
      target: prepared.source.target,
      dryRun: true,
      personas,
      files,
      warnings: prepared.source.warnings,
    };
  }

  const committed = await commitFiles(options.cwd, prepared.files);
  return {
    ok: true,
    target: prepared.source.target,
    dryRun: false,
    personas,
    files: committed.statuses,
    warnings: prepared.source.warnings,
  };
}
