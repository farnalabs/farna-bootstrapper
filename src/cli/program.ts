import { Command } from 'commander';
import { PRODUCT_NAME, PRODUCT_VERSION } from '../core/constants.js';
import type { RenderTarget } from '../render/port.js';
import { formatCheck, formatGenerate, formatInit, formatJson } from '../report/format.js';
import { runCheck } from './commands/check.js';
import { runGenerate } from './commands/generate.js';
import { runInit } from './commands/init.js';

export type CliContext = {
  cwd: string;
  renderer: RenderTarget;
  stdout: (text: string) => void;
};

type CommonOptions = { json?: boolean };

/** Commander wiring for the three commands this slice implements. */
export function buildProgram(context: CliContext): Command {
  const program = new Command();
  const identity = context.renderer.identity();
  program
    .name(PRODUCT_NAME)
    .description(
      'Compile named agent personas and resources into harness configuration, and prove the output still matches the source.',
    )
    .version(
      `${PRODUCT_NAME} ${PRODUCT_VERSION} (renderer ${identity.name} ${identity.version})`,
      '-v, --version',
    )
    .showSuggestionAfterError()
    .showHelpAfterError();

  program
    .command('init')
    .description('create .farna/config.jsonc and the empty source directories')
    .option('--json', 'print one JSON object')
    .action(async (options: CommonOptions) => {
      const result = await runInit(context.cwd);
      context.stdout(options.json === true ? formatJson(result) : formatInit(result));
    });

  program
    .command('generate')
    .description('render every persona and write the verified files into the repository')
    .option('--dry-run', 'print the plan without writing anything')
    .option('--json', 'print one JSON object')
    .action(async (options: { dryRun?: boolean; json?: boolean }) => {
      const result = await runGenerate(
        { cwd: context.cwd, dryRun: options.dryRun === true },
        context.renderer,
      );
      context.stdout(options.json === true ? formatJson(result) : formatGenerate(result));
    });

  program
    .command('check')
    .description('regenerate into a temporary directory and compare with the repository')
    .option('--json', 'print one JSON object')
    .action(async (options: CommonOptions) => {
      const result = await runCheck(context.cwd, context.renderer);
      context.stdout(options.json === true ? formatJson(result) : formatCheck(result));
      if (!result.ok) {
        process.exitCode = result.exitCode;
      }
    });

  return program;
}
