#!/usr/bin/env node
import { FarnaError } from '../core/errors.js';
import { UpstreamRenderTarget } from '../render/upstream.js';
import { formatJson } from '../report/format.js';
import { buildProgram, failureObject, unexpectedFailureObject } from './program.js';

/**
 * Process entry point. This is the only place where a concrete renderer is
 * bound to the `RenderTarget` port. `--json` is detected here as well as in
 * the command wrapper, so a failure before a command action runs (an
 * unreadable installed renderer, for example) still produces one object.
 */
const json = process.argv.includes('--json');
const command = process.argv.slice(2).find((argument) => !argument.startsWith('-')) ?? null;

try {
  const program = buildProgram({
    cwd: process.cwd(),
    renderer: new UpstreamRenderTarget(),
    stdout: (text) => process.stdout.write(text),
    argv: process.argv,
  });
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof FarnaError) {
    if (json) {
      process.stdout.write(formatJson(failureObject(command, error)));
    }
    process.stderr.write(`${error.format()}\n`);
    process.exitCode = error.exitCode;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      process.stdout.write(formatJson(unexpectedFailureObject(command, message)));
    }
    process.stderr.write(`farna-bootstrapper: unexpected error\n  ${message}\n`);
    process.exitCode = 1;
  }
}
