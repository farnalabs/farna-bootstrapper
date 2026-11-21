import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `tests/cli` runs the built `dist/cli/main.js`, while `tests/unit/assert-pack`
    // and `tests/integration/install` run `npm pack`, whose `prepack`/`prepare`
    // hooks rebuild `dist` with tsc, and `assert-pack` moves `dist` aside while
    // it packs. Those files share one build output, so a parallel worker can
    // observe a half-written or absent `dist` and report a spurious CLI failure.
    // One file at a time costs seconds and removes the race entirely.
    fileParallelism: false,
  },
});
