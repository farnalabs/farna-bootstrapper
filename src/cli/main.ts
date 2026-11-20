#!/usr/bin/env node
import { FarnaError } from '../core/errors.js';
import { UpstreamRenderTarget } from '../render/upstream.js';
import { buildProgram } from './program.js';

/**
 * Process entry point. This is the only place where a concrete renderer is
 * bound to the `RenderTarget` port.
 */
const program = buildProgram({
  cwd: process.cwd(),
  renderer: new UpstreamRenderTarget(),
  stdout: (text) => process.stdout.write(text),
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof FarnaError) {
    process.stderr.write(`${error.format()}\n`);
    process.exitCode = error.exitCode;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`farna-bootstrapper: unexpected error\n  ${message}\n`);
    process.exitCode = 1;
  }
}
