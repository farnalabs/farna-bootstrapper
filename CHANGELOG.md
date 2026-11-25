# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, a minor
release may contain a breaking change; every change of that kind is listed under **Changed**.

## [Unreleased]

### Changed

- **Renderer pin moved to `rulesync` 43.14.0** (from `43.13.0`). One emitted artefact changes: the
  V1 OpenCode hooks plugin (`.opencode/plugins/rulesync-hooks.js`). Its `preToolUse` stdout-result
  parser now returns early when stdout does not parse to an object, reads
  `hookSpecificOutput.permissionDecision` when that field is present, and otherwise falls back to
  the legacy `decision: "block"` and `reason` fields, so a hook that reports its block in the older
  shape is still honoured. The V2 OpenCode plugin carries the same parser change but is not
  byte-pinned by a golden. Every other emitted artefact is byte-identical: the V1 and V2 agent
  files, the V1 `opencode.jsonc`, the commands, the skills and the `claudecode` golden are
  unchanged. The committed dogfood output is regenerated, and `.farna/lock.json` changes only in
  its recorded renderer version and integrity; its schema stays version 2.

## [0.1.3] - 2026-11-24

### Added

- **Self-dogfood.** This repository now generates its own configuration from `.farna/`:
  `.claude/agents/maintainer.md` and `.farna/lock.json` are generated and committed, and CI runs
  `check`, so a source change that was not regenerated, or a generated file edited by hand, fails
  the build. The dogfood covers the `claudecode` target in agent mode only.
- **A macOS CI job.** CI runs a second job on macOS with every step identical to the Linux job, so
  the same install, build, test, audit and `check` steps are proven on both platforms.
- **Weekly renderer-pin tracking.** `.github/workflows/renderer-pin.yml` compares the pinned
  renderer with the published npm version once a week, opens one tracking issue when the pin is
  behind, comments on that issue weekly while it stays behind, and closes it when the pin catches
  up. It never bumps anything. A new `## Absorbing a renderer upgrade` runbook in
  [CONTRIBUTING.md](CONTRIBUTING.md#absorbing-a-renderer-upgrade) documents the manual absorb
  procedure.
- **A roadmap.** [ROADMAP.md](ROADMAP.md) records what is shipped, what is next and what is
  deliberately out of scope, and the README status section links to it.

### Changed

- **Renderer pin moved to `rulesync` 43.13.0** (from `43.11.0`), absorbed in two explained steps.
  An OpenCode agent file whose description contains a comma now writes it as a plain YAML scalar
  instead of a single-quoted one: the renderer replaced its frontmatter serialiser (`gray-matter`'s
  YAML 1.1 writer) with YAML 1.2, where a comma is plain-safe. The pin also carried the 43.12.0
  change: a `session-start` hook runs with `context: true`, so its stdout is captured as session
  context while its stderr streams to the host, and the plugin's run helper returns its result on
  success. The `claudecode` golden is byte-identical. Because the agent files and the plugin are
  managed output, `check` reports drift on an existing project until the next `generate`.

### Fixed

- **An emitted OpenCode hook matcher now fires.** The generated hooks plugin writes the tool ids the
  harness reports, lowercased and anchored, instead of the canonical names: `Edit|Write` is written
  as `^(?:edit|write)$`, and `Bash` as `^(?:bash)$` on V1 and `^(?:shell)$` on V2. OpenCode reports
  those lowercase ids, so a declared matcher matches a tool call instead of silently never
  matching. The containment gate applies the same translation before comparing.

## [0.1.2] - 2026-11-23

### Added

- **`doctor`.** Validates a `.farna` source without rendering or writing: the config schema, persona
  and resource references, `extends` cycles, the model map, target support, permission categories
  and patterns, secret references, path and symlink safety, and the profile-mode invariants. It
  reuses the same config loader, source loader and resolver as `generate` and `check`, so it cannot
  accept a source they refuse. A failure carries the same typed code and exit status; `--json`
  emits one object, and the human report lists every check that ran, every resolved persona and
  resource with its source path, and every warning.
- **`report`.** Prints the measured capability matrix for all three supported targets, with two
  emissions per capability (per persona and workspace level) and a per-key permission table. The
  vocabulary is `native`, `emulated`, `dropped` and `unknown`; `unknown` renders as `[?] not
  measured` and is never a tick. `--json` emits the same claim as data. The command reads no source
  tree and writes nothing.
- **A structural matrix guard.** `verifySnapshot` refuses (F010) a snapshot measured against a
  different renderer, a missing supported-target row, or an `unknown` cell on a promised target.

### Changed

- The README, `CONTRIBUTING.md` and `--help` describe the five-command surface and the capability
  report.

### Fixed

- The `CONTRIBUTING.md` release example used `v0.1.0` as its tag; it now uses the current release
  version.

## [0.1.1] - 2026-11-22

### Added

- **Persona `mode`.** A persona may declare `mode: primary`, `subagent` or `all`, which both
  OpenCode targets emit as the per-agent `mode`. The default when the key is absent is `subagent`,
  so an existing source renders byte for byte as before. The value composes with `extends`: a
  derived persona inherits its base's mode and may override it.
- **`W117_PERSONA_MODE_IGNORED`.** Claude Code has no primary/subagent mode, so a persona that
  declares `mode` on the `claudecode` target is reported at info severity, naming the persona and
  the target, and the emitted Claude Code file carries no `mode` key.

Both OpenCode examples now declare `mode: primary` on their live persona, and the README documents
the field, its composition and the Claude Code warning.

## [0.1.0] - 2026-11-22

The first public release. `farna-bootstrapper` compiles named agent personas and their resources
into the configuration a coding harness reads, records what it wrote, and proves the committed
output still matches the source.

### Added

- **Three commands.** `init` creates the `.farna/` source root, the empty resource directories, and
  the `.gitignore` and `.gitattributes` lines the generated files need. `generate` renders,
  verifies and writes the managed files plus `.farna/lock.json`; `--dry-run`, `--adopt` and
  `--json` are supported. `check` re-renders into a temporary directory and exits `1` on any drift.
- **Three targets.** `claudecode` writes `.claude/agents/<id>.md`; `opencode` (OpenCode V2, package
  `@opencode/cli`) and `opencodev1` (OpenCode V1, package `opencode-ai`) both write
  `.opencode/agents/<id>.md` in each major's own shapes. Exactly one target is configured per run.
- **OpenCode V1 support (`opencodev1`).** The V1 target writes OpenCode 1.x shapes: V1 agent
  frontmatter with `name` and the per-tool `permission` map, the flat `mcp.<name>` map with
  `enabled: true`, V1 command frontmatter and the `RulesyncHooksPlugin` module. Profile mode works
  for both OpenCode targets, and a target switch rewrites the recorded paths in place rather than
  orphaning them. Configuring both OpenCode targets in one run is `F001`. `examples/opencode-v1/`
  is the V1 profile-mode example; `examples/opencode-v2/` is the V2 profile-mode example and uses
  `@opencode/cli`.
- **Agent and profile modes.** Agent mode is the default and carries every persona per agent.
  Profile mode, supported for both OpenCode targets, makes exactly one persona live so it can own
  the workspace: `opencode.jsonc` at the repository root, plus its skills, commands and hooks under
  `.opencode/`. `targets.opencode.active` selects the persona, and `--persona` overrides it for one
  run. Every resolved-but-not-live persona is reported (`notLive`).
- **Persona composition.** A persona may extend one base persona. Rules and permissions are unioned
  by `(kind, id)`, the stricter permission value wins, and two different concrete models in one
  composed set are refused.
- **Six resource kinds plus a model class.** `rule`, `permission`, `mcp`, `skill`, `command` and
  `hook` are strict sources; a persona names its model class in the persona file. MCP credentials
  are environment references only.
- **Permission mapping.** Canonical categories map to each target's own byte form: Claude Code's
  `Read`/`Write`/`Edit`/`Bash`/`Agent` entries and per-agent `tools`/`disallowedTools`; OpenCode's
  ordered `{ action, resource, effect }` records. A category neither target can carry is refused rather
  than emitted as an inert string. An opt-in Claude Code `tools` allow-list is reported when it
  narrows the tool set.
- **Ownership with an explicit record.** `.farna/lock.json` records every managed path with its
  size and SHA-256, each persona's composition and digests, the source warnings, and the pinned
  renderer identity. It contains no timestamps, hostnames or absolute paths. `generate` removes a
  recorded orphan only when it is in a managed location, is still a regular file, still has the
  recorded bytes, and is recorded. `opencode.jsonc` is owned by its `mcp` key only, edited in
  place so the user's own keys and comments survive.
- **Renderer pin.** `rulesync` is pinned to exactly `43.11.0` with a tarball integrity, imported by
  one module behind a port. A different version is refused; a different npm-recorded integrity is
  refused; when no integrity can be found the version check still applies and
  `W114_RENDERER_INTEGRITY_UNVERIFIED` names the gap.
- **Fail-closed generation.** Every gate runs before the first byte is written. Managed files are
  staged and renamed; a caught write failure restores what it replaced and names anything it could
  not restore. One `generate` runs at a time through a local lock.
- **Release packaging.** The package publishes the ESM library types entry, the CLI `bin`, the
  README, CHANGELOG, LICENSE, NOTICE and SECURITY.md. Publishing uses npm provenance.
- **No telemetry, no phone-home, no Farna Control dependency.** Generation and checking make no
  network request of their own, and a hook, MCP server or command the tool writes is never executed
  by it.

### Known limitations

- **One target per run.** More than one configured target is refused; the lockfile and mode plan
  are per-target.
- **No `doctor` command.** `--dry-run` prints the plan, but there is no capability-report command.
- **`claudecode` profile mode is not implemented**, and the workspace resource kinds (`mcp`,
  `skill`, `command`, `hook`) are not carried by `claudecode` at all in this release.
- **Both OpenCode targets carry the workspace resource kinds in profile mode only.** Agent mode
  refuses a reference with `F001` rather than emitting it workspace-wide. A hook OpenCode cannot
  represent (`session-end`, or a matcher on a non-tool event) is reported (`W101`) and not emitted.
- **No cross-target single run, no `patch`/`replaceWith`, no per-target filters, no `--strict`, no
  `.farna/local.jsonc` override, no region ownership (`CLAUDE.md`/`AGENTS.md`).** `opencode.jsonc`
  is the only structured file, and the only key it owns is `mcp`.
- **TOCTOU and crash windows remain.** A symlink swapped in between the `lstat` preflight and the
  write is not detected; a process kill between two renames can leave a mixed tree that `check`
  reports and a re-run repairs.
- **The renderer pin is provenance, not a sandbox.** A renderer patched in place with the same
  version and tarball integrity is not detected.
- **No coverage threshold.** CI enforces lint, type-check, tests (with a minimum count and
  real-renderer suite assertions), a dependency audit at `moderate`, and the published-tarball
  contents.
- **Windows test skips.** The symlink regression suites (creating a symlink needs a privilege the
  runner does not grant), the POSIX mode assertions, the FIFO cases and the install-layout suite are
  skipped on Windows; CI runs them on Linux.

[Unreleased]: https://github.com/farnalabs/farna-bootstrapper/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/farnalabs/farna-bootstrapper/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/farnalabs/farna-bootstrapper/releases/tag/v0.1.2
[0.1.1]: https://github.com/farnalabs/farna-bootstrapper/releases/tag/v0.1.1
[0.1.0]: https://github.com/farnalabs/farna-bootstrapper/releases/tag/v0.1.0
