import { Command } from 'commander';
import {
  CONFIG_PATH,
  DRIFT_CODE,
  EXIT,
  OPENCODE_SUPPORTED_MAJOR,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  SCHEMA_VERSION,
} from '../core/constants.js';
import { FarnaError } from '../core/errors.js';
import type { RenderTarget } from '../render/port.js';
import { RENDERER_PIN } from '../render/upstream.js';
import { formatCheck, formatGenerate, formatInit, formatJson } from '../report/format.js';
import { runCheck } from './commands/check.js';
import { runGenerate } from './commands/generate.js';
import { runInit } from './commands/init.js';

export type CliContext = {
  cwd: string;
  renderer: RenderTarget;
  stdout: (text: string) => void;
  /** The process argv, so a pre-command `--json` can still be honoured. */
  argv: readonly string[];
};

type CommandName = 'init' | 'generate' | 'check';

type CommandOutcome = {
  payload: Record<string, unknown>;
  text: string;
  exitCode: number;
};

/** The one machine-readable failure object: the same keys for every command. */
export function failureObject(command: string | null, error: FarnaError): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    ok: false,
    exitCode: error.exitCode,
    code: error.code,
    subject: error.subject ?? null,
    message: error.message,
  };
}

/** The same failure object for a throw that carries no diagnostic code. */
export function unexpectedFailureObject(
  command: string | null,
  message: string,
): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    ok: false,
    exitCode: EXIT.invalidConfig,
    code: null,
    subject: null,
    message,
  };
}

/**
 * Strip the repository root from a message that escaped as an untyped error, so
 * the one failure with no diagnostic code still names a repository-relative
 * subject rather than leaking an absolute path. Both separators are handled:
 * the message may come from a platform library or from a tool.
 */
export function redactRoot(message: string, root: string): string {
  const withoutTrailing = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root;
  return message
    .replaceAll(`${withoutTrailing}/`, '')
    .replaceAll(`${withoutTrailing}\\`, '')
    .replaceAll(withoutTrailing, '.');
}

/**
 * Run one command and marshal its result. `--json` emits an object on stdout
 * for a typed failure as well as for success; the human line always goes to
 * stderr, and the exit code is always the diagnostic's own code.
 */
async function emit(
  command: CommandName,
  json: boolean,
  context: CliContext,
  run: () => Promise<CommandOutcome>,
): Promise<void> {
  try {
    const outcome = await run();
    context.stdout(json ? formatJson(outcome.payload) : outcome.text);
    if (outcome.exitCode !== 0) {
      process.exitCode = outcome.exitCode;
    }
  } catch (error) {
    if (!(error instanceof FarnaError)) {
      throw error;
    }
    if (json) {
      context.stdout(formatJson(failureObject(command, error)));
    }
    process.stderr.write(`${error.format()}\n`);
    process.exitCode = error.exitCode;
  }
}

/** Commander wiring for the three commands this slice implements. */
export function buildProgram(context: CliContext): Command {
  const program = new Command();
  program
    .name(PRODUCT_NAME)
    .description(
      'Compile named agent personas and resources into harness configuration, and prove the output still matches the source.',
    )
    .addHelpText(
      'after',
      `\nThe OpenCode target supports OpenCode ${OPENCODE_SUPPORTED_MAJOR}.x only; the 1.x layout is unsupported.
\nProfile mode: pass --persona <id> to generate or check, or set "active" under a target
in .farna/config.jsonc. Exactly one persona is live and owns the workspace: its
opencode.jsonc is written at the repository root, and its skills, commands and hooks
under .opencode/. Profile mode is supported for the opencode target; agent mode
remains the default.`,
    )
    .version(
      // The compiled-in pin, never the installed renderer: `--version` and
      // `init` must work when the renderer is missing or broken.
      `${PRODUCT_NAME} ${PRODUCT_VERSION} (renderer ${RENDERER_PIN.name} ${RENDERER_PIN.version})`,
      '-v, --version',
    )
    .showSuggestionAfterError()
    .showHelpAfterError()
    // Throw instead of calling process.exit, so main can emit the same JSON
    // failure object for a usage error (an unknown option, a missing value).
    .exitOverride();

  program
    .command('init')
    .exitOverride()
    .description(`create ${CONFIG_PATH} and the empty source directories`)
    .option('--json', 'print one JSON object')
    .action(async (options: { json?: boolean }) => {
      await emit('init', options.json === true, context, async () => {
        const result = await runInit(context.cwd);
        return {
          payload: {
            schemaVersion: SCHEMA_VERSION,
            command: 'init',
            ...result,
            exitCode: EXIT.ok,
          },
          text: formatInit(result),
          exitCode: EXIT.ok,
        };
      });
    });

  program
    .command('generate')
    .exitOverride()
    .description('render every live persona and write the verified files into the repository')
    .option('--dry-run', 'print the plan without writing anything')
    .option(
      '--adopt',
      'take ownership of every existing planned managed output (required when the lockfile is missing)',
    )
    .option('--persona <id>', 'run profile mode as this persona (overrides the configured active)')
    .option('--json', 'print one JSON object')
    .action(
      async (options: { adopt?: boolean; dryRun?: boolean; json?: boolean; persona?: string }) => {
        await emit('generate', options.json === true, context, async () => {
          const result = await runGenerate(
            {
              cwd: context.cwd,
              dryRun: options.dryRun === true,
              ...(options.adopt === true ? { adopt: true } : {}),
              ...(options.persona === undefined ? {} : { persona: options.persona }),
            },
            context.renderer,
          );
          return {
            payload: {
              schemaVersion: SCHEMA_VERSION,
              command: 'generate',
              ...result,
              exitCode: EXIT.ok,
            },
            text: formatGenerate(result),
            exitCode: EXIT.ok,
          };
        });
      },
    );

  program
    .command('check')
    .exitOverride()
    .description('regenerate into a temporary directory and compare with the repository')
    .option('--persona <id>', 'run profile mode as this persona (overrides the configured active)')
    .option('--json', 'print one JSON object')
    .action(async (options: { json?: boolean; persona?: string }) => {
      await emit('check', options.json === true, context, async () => {
        const result = await runCheck(context.cwd, context.renderer, {
          ...(options.persona === undefined ? {} : { persona: options.persona }),
        });
        const payload: Record<string, unknown> = {
          schemaVersion: SCHEMA_VERSION,
          command: 'check',
          ...result,
        };
        if (!result.ok) {
          // The same failure keys the typed-error path carries, so a consumer
          // never has to special-case drift to learn it failed. The top-level
          // code is always the drift code; an item's own code (`W107` for
          // content outside ownership) stays in the `drift` array, because a
          // path that sorts first must not decide what kind of failure the run
          // is.
          payload['code'] = DRIFT_CODE;
          payload['subject'] = result.drift[0]?.path ?? null;
          payload['message'] = 'managed output drifted from a fresh render';
        }
        return { payload, text: formatCheck(result), exitCode: result.exitCode };
      });
    });

  // A listener here replaces Commander's default "unknown command" error and
  // process exit, so the same machine-readable object can be emitted.
  program.on('command:*', (operands: string[]) => {
    const attempted = operands[0] ?? '';
    const message = `unknown command "${attempted}"`;
    if (context.argv.includes('--json')) {
      context.stdout(
        formatJson(unexpectedFailureObject(attempted === '' ? null : attempted, message)),
      );
    }
    process.stderr.write(`${PRODUCT_NAME}: ${message}\n`);
    process.exitCode = EXIT.invalidConfig;
  });

  return program;
}
