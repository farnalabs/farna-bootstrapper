import { commitFiles, type FileStatus, inspectManagedTarget } from '../../render/commit.js';
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
      // The same containment and type checks the write path makes: dry-run
      // must not read a plan through a symlinked or non-directory ancestor.
      // Compare bytes: decoded text can collapse an invalid byte and a genuine
      // U+FFFD to the same string, reporting "unchanged" for a file that needs
      // repair.
      const current = await inspectManagedTarget(options.cwd, file.path);
      const matches =
        current.existing !== undefined && current.existing.equals(Buffer.from(file.bytes, 'utf8'));
      files.push({
        path: file.path,
        status: matches ? 'unchanged' : 'would-write',
      });
    }
    return {
      ok: true,
      target: prepared.source.target,
      dryRun: true,
      personas,
      files,
      warnings: prepared.warnings,
    };
  }

  const committed = await commitFiles(options.cwd, prepared.files);
  return {
    ok: true,
    target: prepared.source.target,
    dryRun: false,
    personas,
    files: committed.statuses,
    warnings: prepared.warnings,
  };
}
