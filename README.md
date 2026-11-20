# farna-bootstrapper

Compile named agent personas and their resources into the configuration a coding harness
actually reads, and prove that the committed output still matches the source.

This repository is at **M1, the first vertical slice**. It implements one target
(`claudecode`), two commands of the compiler loop (`generate`, `check`) plus `init`, and one
resource kind per persona (`rule`). Everything else is deliberately deferred; see
[What this slice does not do](#what-this-slice-does-not-do).

## The loop

1. You declare personas and their rules under `.farna/`.
2. `farna-bootstrapper generate` renders the Claude Code agent files into `.claude/agents/` and
   records what it wrote in `.farna/lock.json`.
3. `farna-bootstrapper check` renders the same input into a temporary directory and compares it
   with the repository. Exit `0` when identical, `1` when anything drifted.

`generate` never writes until every gate has passed. Each persona's body must contain its own
rule text, and must not contain another persona's exclusive rule text. A renderer that drops
content or mixes personas is refused before the first byte reaches the repository.

## Requirements

- Node.js **22.22.0 or newer**
- npm

## Develop

```sh
npm ci
npm run lint
npm test
npm run build
```

`npm run build` compiles `src/` to `dist/`. After a build, run the CLI with
`node dist/cli/main.js`, or link it with `npm link` to get the `farna-bootstrapper` binary.

The integration test in `tests/integration/` drives the real, pinned renderer. It runs when the
`rulesync` dependency is installed, which `npm ci` guarantees, and is skipped otherwise.

## Use

```sh
mkdir my-agents && cd my-agents
farna-bootstrapper init
```

`init` creates:

```text
.farna/
  config.jsonc
  personas/
  resources/
.gitignore        # with .farna/local.jsonc and .farna/.journal.json
```

Add one YAML file per persona under `.farna/personas/`, and one Markdown file per rule under
`.farna/resources/rules/`:

```yaml
# .farna/personas/builder.yaml
kind: persona
id: builder
displayName: Builder
purpose: Writes code, runs the tests, and follows the house conventions.
model: standard
resources:
  - rule/house-style
```

```markdown
---
kind: rule
id: house-style
displayName: House style
---

Write the smallest change that satisfies the ticket.

Run the tests before you report.
```

```jsonc
// .farna/config.jsonc
{
  "schemaVersion": 1,
  "targets": { "claudecode": {} },
  "models": {
    "standard": { "claudecode": "claude-sonnet-4-5" }
  }
}
```

Then run:

```sh
farna-bootstrapper generate          # write the agent files and the lockfile
farna-bootstrapper generate --dry-run # print the plan, write nothing
farna-bootstrapper check             # prove the tree matches a fresh render
```

`generate` and `check` accept `--json` for one machine-readable object on stdout.

A persona's rule text is joined into the body of its Claude Code subagent, in canonical rule-id
order, under a `## displayName` heading. The rule body itself is never re-wrapped or re-indented.

## Layout

```text
src/
  cli/            Commander wiring, the three commands, and the error boundary
  config/         strict JSONC config schema and loader
  source/         YAML personas, markdown rules, strict frontmatter
  compose/        resource reference resolution
  materialise/    persona -> rulesync source tree
  render/         port.ts (the seam), upstream.ts (the only rulesync import), stage, commit
  verify/         containment and cross-persona isolation gates
  lock/           lockfile construction
  report/         text and JSON output
tests/
  fixtures/demo/  one .farna tree with two personas and two distinct rules
  unit/           fake-renderer tests, gates, loader, init, check, canonical JSON
  integration/    the real pinned renderer
```

`.farna/lock.json` records the renderer identity, each persona's resolved resources, and the
path, size and SHA-256 of every managed file. It contains no timestamps, hostnames or absolute
paths.

## The renderer boundary

`src/render/port.ts` defines `RenderTarget`. `src/render/upstream.ts` is the only module that
imports `rulesync`, and `src/cli/main.ts` is the only place that binds the real implementation.
Unit tests use an independent fake renderer, so the failure modes the port exists to catch can be
exercised without the network or the real renderer.

`rulesync` is pinned to exactly `43.11.0`; its integrity is recorded in the lockfile. The product
never uses rulesync's `--delete`; cleanup is ownership-scoped, and this slice never deletes a user
file.

## What this slice does not do

Deliberately out of scope, by milestone:

- `doctor`; profile mode; composition and `extends`; union and conflict resolution
- the `permission`, `mcp`, `skill`, `command`, `hook` and `model` resource kinds (a model is
  expressed as the persona's `model` class in this slice)
- deletion or sweeping of orphaned managed files: `check` reports an unexpected path and
  `generate` never deletes a file it did not write in the current run
- the OpenCode target and every other target; the full 71-target capability matrix
- structured or region ownership; only whole files are owned
- `--strict` and the warning table; `--accept-config` gating
- the weekly renderer-sync bot and the two compiled binaries

## Deviations from `design/`

This slice is intentionally narrower than the M1 described in the design documents. The
differences, all deliberate:

1. **npm and Node, not Bun.** The design pins `bun` as the package manager and test runner. Bun is
   not installed on the delivery host, so this slice uses npm, `tsc` and Vitest. The package
   exposes the same ESM build and `bin`, and `engines.node` is unchanged at `>=22.22.0`.
2. **Personas are YAML, not JSONC.** The brief for this slice specifies
   `.farna/personas/*.yaml`. The design's JSONC persona format, with its parse-tree duplicate-key
   rules, remains the M2 target. Config stays JSONC with duplicate keys rejected.
3. **`init` creates two directories, not seven.** This slice creates `personas/` and `resources/`.
   Empty `resources/<kind>/` directories for the other resource kinds are M2, because those kinds
   do not exist yet and an empty directory that generates nothing is noise.
4. **Only `rule` and a model class are resolvable.** A persona may reference `rule/<id>` and name a
   `model` class. Any other resource kind is rejected with a clear error rather than accepted and
   ignored. `targets.<t>.active` and `exclude` are also rejected: profile mode and per-target
   filters are M2, and accepting them here would be a silent no-op. For the same reason
   `ignoredFiles` is not accepted yet: its glob filtering is M2, and an unknown-key error is louder
   than a setting that quietly does nothing.
5. **`check` exits `1` on any drift.** `schema.md` §7 assigns `F007` exit `4`. The brief for this
   slice requires `0` clean / `1` drift, so `check` returns `1` and reports the `F007` code in its
   payload. `generate` keeps the design's per-code exits (`F008` is `4`).
6. **No matrix snapshot or matrix digest.** The one-target, seven-cell snapshot, `probe`, and the
   `matrixDigest` lockfile field are M2. The lockfile records the renderer identity, personas and
   managed files only.
7. **No `.farna/local.jsonc` reader.** `init` adds the path to `.gitignore`, but per-developer
   selection is M2 with profile mode.
8. **One recursive delete exists, in `src/render/stage.ts`.** It removes only the `mkdtemp`
   directory the stage created, after proving it is inside the canonical temporary root. The
   design's "no recursive delete in `src/`" rule is about never deleting user content; a
   self-created temp stage is the one justified exception, and stage cleanup is required.

## Licence

MIT, copyright Farnalabs Ltd. See `LICENSE` and `NOTICE`. This project depends on
[rulesync](https://github.com/dyoshikawa/rulesync) (MIT, dyoshikawa and contributors), used
unmodified as a library.
