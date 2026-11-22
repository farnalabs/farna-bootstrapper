# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, a minor
release may contain a breaking change; every change of that kind is listed under **Changed**.

## [Unreleased]

### Added

- **OpenCode 1.x support (`opencodev1`).** A second OpenCode target, alongside `opencode` (2.x),
  which writes the same paths in OpenCode 1.x shapes: V1 agent frontmatter with `name` and the
  per-tool `permission` map, the flat `mcp.<name>` map with `enabled: true`, V1 command frontmatter
  and the `RulesyncHooksPlugin` module. Profile mode works for both OpenCode targets, and a target
  switch rewrites the recorded paths in place rather than orphaning them. Configuring both OpenCode
  targets in one run is `F001`. `examples/opencode-v1/` is the new profile-mode example;
  `examples/opencode-profile/` is renamed `examples/opencode-v2/` and uses `@opencode/cli`.

## [0.1.0] - 2026-11-22

The first public release. `farna-bootstrapper` compiles named agent personas and their resources
into the configuration a coding harness reads, records what it wrote, and proves the committed
output still matches the source.

### Added

- **Three commands.** `init` creates the `.farna/` source root, the empty resource directories, and
  the `.gitignore` and `.gitattributes` lines the generated files need. `generate` renders,
  verifies and commits the managed files plus `.farna/lock.json`; `--dry-run`, `--adopt` and
  `--json` are supported. `check` re-renders into a temporary directory and exits `1` on any drift.
- **Two targets.** `claudecode` writes `.claude/agents/<id>.md`; `opencode` (2.x) writes
  `.opencode/agents/<id>.md`. Exactly one target is configured per run. (An unreleased follow-up
  adds `opencodev1` for OpenCode 1.x.)
- **Agent and profile modes.** Agent mode is the default and carries every persona per agent.
  Profile mode, supported for `opencode`, makes exactly one persona live so it can own the
  workspace: `opencode.jsonc` at the repository root, plus its skills, commands and hooks under
  `.opencode/`. `targets.opencode.active` selects the persona, and `--persona` overrides it for one
  run. Every resolved-but-not-live persona is reported (`notLive`).
- **Persona composition.** A persona may extend one base persona. Rules and permissions are unioned
  by `(kind, id)`, the stricter permission value wins, and two different concrete models in one
  composed set are refused.
- **Six resource kinds plus a model class.** `rule`, `permission`, `mcp`, `skill`, `command` and
  `hook` are strict sources; a persona names its model class in the persona file. MCP credentials
  are environment references only.
- **Permission mapping.** Canonical categories map to each target's own byte form: Claude Code's
  `Read`/`Edit`/`Bash`/`Agent` entries and per-agent `tools`/`disallowedTools`; OpenCode's ordered
  `{ action, resource, effect }` records. A category neither target can carry is refused rather
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
  README, CHANGELOG, LICENSE and NOTICE. Publishing uses npm provenance.
- **No telemetry, no phone-home, no Farna Control dependency.** Generation and checking make no
  network request of their own, and a hook, MCP server or command the tool writes is never executed
  by it.

### Known limitations

- **One target per run.** Two configured targets are refused; the lockfile and mode plan are
  per-target.
- **No `doctor` command.** `--dry-run` prints the plan, but there is no capability-report command.
- **`claudecode` profile mode is not implemented**, and the workspace resource kinds (`mcp`,
  `skill`, `command`, `hook`) are not carried by `claudecode` at all in this release.
- **`opencode` carries the workspace resource kinds in profile mode only.** Agent mode refuses a
  reference with `F001` rather than emitting it workspace-wide. A hook OpenCode cannot represent
  (`session-end`, or a matcher on a non-tool event) is reported (`W101`) and not emitted.
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
- **Windows test skips.** The symlink regression tests are skipped on Windows because creating a
  symlink needs a privilege the runner does not grant; CI runs them on Linux.

[Unreleased]: https://github.com/farnalabs/farna-bootstrapper/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/farnalabs/farna-bootstrapper/releases/tag/v0.1.0
