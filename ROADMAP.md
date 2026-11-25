# Roadmap

`farna-bootstrapper` compiles named agent personas and their resources into the configuration a
coding harness reads, and proves that the committed output still matches the source. The latest
published release is **0.2.0** (2026-11-25).

This is a pre-1.0 project. Everything below describes what exists today and what is intended next;
it is not a promise of dates or a claim of production readiness.

## Shipped

What `main` does today, all of it covered by the test suite and by CI.

- **Five commands.** `init`, `doctor`, `report`, `generate` and `check`. `doctor` validates a source
  without rendering or writing; `report` prints the measured capability matrix and reads no source;
  `generate` renders, verifies and writes; `check` re-renders into a temporary directory and exits
  `1` on any drift without writing.
- **Three targets.** `claudecode`; `opencode` for OpenCode 2.x (`@opencode/cli`); and `opencodev1`
  for OpenCode 1.x (`opencode-ai`). Agent mode works on all three. Profile mode works on both
  OpenCode targets; `claudecode` refuses it rather than accepting a setting that does nothing.
- **Six resource kinds plus a model class.** `rule`, `permission`, `mcp`, `skill`, `command` and
  `hook`, with the persona's model declared as a class in the persona file.
- **Single-parent composition.** `extends` names at most one base persona. Rules and permissions are
  unioned, the stricter permission value wins, and two different concrete models in one composed set
  are refused rather than silently overridden.
- **Recorded ownership.** `.farna/lock.json` records every managed path with its size and SHA-256,
  each persona's composition and digests, the source warnings, and the pinned renderer identity. It
  contains no timestamps, hostnames or absolute paths.
- **A pinned renderer.** `rulesync` is pinned to an exact version and a tarball integrity. A
  different version, or an integrity npm recorded differently, is refused; when no integrity can be
  found the version check still applies and `W114_RENDERER_INTEGRITY_UNVERIFIED` names the gap.
- **Fail-closed generation.** Every gate runs before the first byte is written, managed files are
  staged and renamed, and one `generate` runs at a time through a local single-writer lock.
- **Reproducible checking.** Two clean runs of the same source on one machine produce identical bytes
  and an identical lockfile, and `check` reports drift instead of repairing it silently. The same
  rules are machine-independent: the lockfile records no timestamp, hostname, absolute path, user
  name or process id, and `.gitattributes` pins generated line endings to LF.
- **Multi-target rendering in one run.** A single `generate` or `check` resolves, renders and
  verifies every configured target, with a per-target lockfile entry and mode plan. `claudecode`
  combines with one OpenCode target; configuring both OpenCode majors is `F005_CONFLICT` (exit 2)
  because they would own the same locations. A mixed config can run one target in agent mode and
  another in profile mode, and `--persona` applies to each target that supports it.
- **Self-dogfood.** This repository's own `.claude/agents/maintainer.md` and
  `.opencode/agents/maintainer.md` are both generated from the same `.farna/` source, as the
  `claudecode` and `opencode` targets in agent mode. `check` runs in CI so an unregenerated source
  change or a hand-edited generated file fails the build.
- **The same CI steps on macOS.** A second CI job runs on macOS with every step identical to the
  Linux job; it passed on its first run, including the full test suite and the `check` gate, so the
  tool is verified on macOS as well as on Linux.
- **A renderer-upgrade routine.** A weekly scheduled workflow (`.github/workflows/renderer-pin.yml`)
  detects when the pinned renderer is behind the published npm version, opens one tracking issue
  while it is behind, and closes it when the pin catches up. Absorbing an upgrade stays a documented
  manual procedure ([CONTRIBUTING.md](CONTRIBUTING.md#absorbing-a-renderer-upgrade)), because every
  emitted byte change needs a human explanation.

## Next

The ordered near-term work. Each item is a concrete outcome, not a theme.

1. **Exercise the tracking issue's full lifecycle.** The renderer-pin workflow has run only on the
   path where the pin matches the published version. When the next renderer version is published,
   confirm that it opens one issue, comments weekly while the pin stays behind, and closes that
   issue when the pin catches up.

The work under Later is ordered by intent, not committed; an item moves here when it is chosen next.

## Later

The larger work, deliberately not next, with the reason each one waits.

- **A measured capability matrix for every harness the renderer supports, and a generated
  capability page.** Today the `report` command prints the measured matrix for the three supported
  targets only, and the matrix is documentation rather than a generated page. [The design
  note](docs/capability-matrix-design.md) proposes growing the matrix one verified target at a time
  and generating the page from the report.
- **Region ownership for shared instruction files (`AGENTS.md`, `CLAUDE.md`), and profile mode for
  Claude Code.** Both need a way to own part of a file, or a profile plan, that the current
  whole-file and `mcp`-key-only ownership model does not have.
- **The remaining declared-but-not-implemented source features** named in the README: per-target
  `exclude` and target filters, `patch`/`replaceWith`, `--strict`, `--accept-config` gating,
  `.farna/local.jsonc` overrides, model resources, and workspace resource kinds in agent mode.
- **A starter library of example personas.** The `examples/` trees show complete source trees, but
  there is no curated set of personas to start from.
- **Compiled standalone binaries, release checksums, and a coverage gate.** The package is published
  as an npm tarball with provenance today, and CI has no coverage threshold.

## Not planned

These are absent by design, restated here so a reader does not have to ask:

- An agent runtime, launcher or framework. The tool writes configuration and never runs an agent,
  proxies a model, or manages a session.
- A model gateway or a hosted service. There is no server and no account.
- Telemetry or phone-home. There is no analytics package, usage ping or crash reporter.
- A dependency on a hosted control plane. Generation and checking make no network request of their
  own.
- A prebuilt Windows binary in this line. The tool is distributed as a Node package rather than a
  native executable, and CI runs on Linux and macOS, not Windows.
- A GUI. The interface is the CLI.
- A caching render root. The profile is the repository root, never a cache directory or a
  subdirectory below another config.

## How this roadmap is kept true

A change that moves a capability updates this file and the README in the same pull request, so the
two cannot drift apart. The CHANGELOG records what shipped in each release, and `check` keeps this
repository's own generated configuration honest against its source.
