# farna-bootstrapper

[![CI](https://github.com/farnalabs/farna-bootstrapper/actions/workflows/ci.yml/badge.svg)](https://github.com/farnalabs/farna-bootstrapper/actions/workflows/ci.yml)

Compile named agent personas and their resources into the configuration a coding harness
actually reads, and prove that the committed output still matches the source.

## What it is

`farna-bootstrapper` is a build-time compiler for coding-agent configuration. You declare personas
and their resources once, under `.farna/`, and it renders the files a harness reads:

- **`generate`** renders every live persona for exactly one configured target, verifies the bytes
  the renderer produced, and only then writes them. It also writes `.farna/lock.json`, which records
  what it owns.
- **`check`** renders the same source into a temporary directory and compares it with the
  repository. Exit `0` when identical, `1` when anything drifted. It never writes.
- **`init`** creates the source root and the ignore/attribute lines generated output needs.
- **`doctor`** validates the source without rendering or writing: schema, references, `extends`
  cycles, the model map, target support, permissions, secret references, paths and profile-mode
  invariants. It exits `0` when the source is valid; when it is not, it reports the loader's own
  typed code and exits non-zero.
- **`report`** prints the measured capability matrix for every supported target, in a human table
  or as one JSON object. It reads no source and writes nothing.

It is a compiler in the useful sense, not a loader:

- the output is **verified, not trusted**. Containment means equality: a renderer that drops a field,
  weakens a permission, mixes two personas or invents a directive is refused before the first byte is
  written. File existence is never accepted as proof.
- a capability a target cannot carry is **reported, never dropped silently**. Every permission
  category is validated before anything is materialised; one the target cannot map refuses the run.
- the output is **reproducible**: no timestamps, hostnames or absolute paths in the lockfile, and the
  same source produces the same bytes and the same lockfile on every machine.
- it works **offline**. Generation and checking make no network request of their own.

## What it is not

- **Not an agent runtime, launcher or framework.** It writes configuration; it does not run an agent,
  proxy a model, or manage a session. A hook, MCP server or command it writes is data that the
  harness may execute later; this tool never executes it.
- **Not a model gateway or a hosted service.** There is no server, no account and no phone-home.
- **Not a telemetry collector.** There is no analytics package, no usage ping and no crash reporter,
  and no dependency on Farna Control at build time or run time.
- **Not a multi-target orchestrator in this release.** Exactly one configured target is rendered per
  run; more than one is refused.
- **Not a replacement for the harness.** It does not claim runtime behaviour. The README's
  capability matrix states what each target carries; the harness remains the authority on what it
  does with it.

## Status

This is the first public release. It implements five commands (`init`, `doctor`, `report`,
`generate` and `check`), three targets (`claudecode`, `opencode` for OpenCode 2.x and `opencodev1`
for OpenCode 1.x), agent mode plus OpenCode profile mode, six resource kinds (`rule`, `permission`,
`mcp`, `skill`, `command` and `hook`) with a model class, and composition with one base persona per
composed persona. Exactly one configured target is rendered per run. Everything else is
deliberately deferred; see
[What this slice does not do](#what-this-slice-does-not-do) and
[Residual risks and known gaps](#residual-risks-and-known-gaps).

## Quickstart

Requires **Node.js 22.22.0 or newer** and npm. Nothing needs to be installed globally.

```sh
mkdir my-agents && cd my-agents
git init
npx farna-bootstrapper init
```

`init` creates `.farna/config.jsonc`, the empty persona and resource directories, and the
`.gitignore` and `.gitattributes` lines generated output needs. Add one YAML file per persona and
one file per resource; [Use](#use) has a complete pair. Then:

```sh
npx farna-bootstrapper doctor     # validate the source; write nothing
npx farna-bootstrapper generate   # render the target and write .farna/lock.json
npx farna-bootstrapper check      # exit 0 when the tree matches a fresh render
npx farna-bootstrapper report     # print the measured capability matrix
```

Commit `.farna/` and the generated files. Running `check` in CI is the drift gate: a hand edit, a
stale render, or a source change that was never regenerated exits `1` and names the path.

## The loop

1. You declare personas and their resources under `.farna/`, and select one target in the config.
   `farna-bootstrapper doctor` validates that declaration without rendering it.
2. `farna-bootstrapper generate` renders that target's artefacts and records what it wrote in
   `.farna/lock.json`. Claude Code gets one whole file per persona under `.claude/agents/`; OpenCode
   in agent mode gets one whole file per persona under `.opencode/agents/` and no workspace file;
   OpenCode in profile mode gets the active persona's agent file, its `opencode.jsonc` at the
   repository root, and its skill, command and hook output under `.opencode/`.
3. `farna-bootstrapper check` renders the same input into a temporary directory and compares it
   with the repository. Exit `0` when identical, `1` when anything drifted.

`generate` never writes until every gate has passed. Containment means equality, not substring
presence: each persona's artefact must be a non-empty markdown file whose emitted frontmatter has
exactly the keys that target writes, with matching values. Claude Code writes `name`, `description`
and `model`, plus `disallowedTools` and, only when a permission resource opts in, `tools`;
OpenCode 2.x writes `description`, `mode`, `model` and the ordered `permissions` records; OpenCode
1.x writes `name`, `description`, `mode`, `model` and the per-tool `permission` map. The body is
exactly that persona's composed body, with one trailing newline normalised. An absent field must be absent, and an extra
field is refused: a renderer that adds a harness directive such as `permissionMode` or `hooks` is
adding a capability the persona never declared. A renderer that drops content, weakens or invents a
permission, mixes personas, prepends or appends anything of its own is refused before the first byte
reaches the repository. Every permission category is validated before anything is materialised: a
category the target cannot carry refuses the run (F011) rather than being emitted as an inert
string.

## Requirements

- Node.js **22.22.0 or newer**
- npm
- For the `opencode` target, OpenCode **2.x** (package `@opencode/cli`, current 2.3.2, installed
  from <https://opencode.ai/v2/install>). Its emitted per-agent file is the V2 shape (`description`,
  `mode`, `model`, ordered `permissions` records, no `name`), its config nests servers under
  `mcp.servers`, and its plugin is the `{ id, setup }` module.
- For the `opencodev1` target, OpenCode **1.x** (package `opencode-ai`, current 1.19.6). Its
  emitted per-agent file is the V1 shape (`name`, `description`, `mode`, `model`, the per-tool
  `permission` map), its config is the flat `mcp.<name>` map, its command frontmatter spells
  `subtask`/`variant` (this product authors only `description`, which both majors share) and its
  plugin is the `RulesyncHooksPlugin` module.
- The tool does not shell out to OpenCode, so a version is documented rather than probed.
- Profile mode is supported for both OpenCode targets. Agent mode works on all three targets.

## Install

```sh
npx farna-bootstrapper --version        # run it once, without installing
npm install --save-dev farna-bootstrapper
npm install -g farna-bootstrapper
```

The package has no `postinstall` script and makes no network request after install. `prepare` builds
`dist/` for a git install and `prepack` builds it for the published tarball; a source checkout
therefore produces a working `bin` without a manual build.

The renderer's integrity is read from exactly two npm lock records at the **install root**,
the nearest ancestor of the product package that owns a `node_modules` directory: the hidden
`<installRoot>/node_modules/.package-lock.json` and `<installRoot>/package-lock.json`. In a hoisted
npm workspace the renderer sits at `<ws>/node_modules/rulesync`, so that workspace root *is* the
install root and its record at `<ws>/package-lock.json` (and its hidden record) is read. In those
records the `packages` map is searched for the renderer's entry under a key ending in
`node_modules/<renderer>`; a nested install (`npm install --install-strategy=nested`), which
records `node_modules/farna-bootstrapper/node_modules/rulesync`, is read from those same two
records. A workspace root *above* the install root, a parent monorepo and a sibling package are not
read and may yield `W114`. Those two records are the only supported source of integrity; every
other npm layout is not promised. When more than one renderer entry matches — for example another
global package's nested copy in a shared global record — its integrity must still equal the pin: a
different tarball is refused (F010), so a stranger's entry cannot stand in for the pinned renderer.

The guarantee is exact: **the installed renderer version is enforced; the integrity is best effort
and is checked only in those two records; if no renderer entry is found there, the tool emits
`W114_RENDERER_INTEGRITY_UNVERIFIED` and does not claim a clean integrity pass.** A different
version is refused (F010, exit 5). A different npm-recorded integrity is refused the same way. When
no renderer entry exists in those records — a global or linked install that wrote no npm lockfile,
or a layout the tool does not read — or the entry has no string integrity, the version check still
applies, the run continues, and the warning says which of the two happened. That warning appears in
the human report and the `--json` warnings array, so a run never claims a clean integrity pass it
could not make. It is deliberately **not** written into `.farna/lock.json`: the lockfile records
source-derived state only (the pin, resolved resources, source-derived warnings, file hashes), and a
runtime verification result must not change the byte-compared artefact. A record that is present
but cannot be read, is a symlink or is not a regular file, or is above the 64 MiB npm-record bound,
is refused (F010) rather than treated as absent: an integrity that exists but cannot be read must
fail exactly like one that differs. The pin is provenance, not a sandbox — it does not make an
unverifiable install verified. That bound is separate from the 4 MiB bound on this product's own
derived `.farna/lock.json`, because npm's record scales with the dependency tree.

### Supported targets

| Target id | Harness | Version | Package | Agent mode | Profile mode |
|---|---|---|---|---|---|
| `claudecode` | Claude Code | not version-probed | — | yes | not in this release |
| `opencode` | OpenCode | 2.x | `@opencode/cli` | yes | yes |
| `opencodev1` | OpenCode | 1.x | `opencode-ai` | yes | yes |

Exactly one target is configured per run; configuring `opencode` and `opencodev1` together is
`F001`. All three targets write different shapes for the same source; switching target is one
config edit (see [Targets](#targets)). The two OpenCode targets write the **same paths** in each
major's own shapes, so a switch rewrites the recorded output in place rather than orphaning it. The
tool never shells out to a harness, so a version is documented rather than detected.

### The library entry

The package also exports its TypeScript types (`.`, `types: ./dist/index.d.ts`). In this release
that entry is types-only: the CLI is the product surface, and there is no runtime library API to
depend on. The `./package.json` subpath is exported for tooling.

## Use

```sh
mkdir my-agents && cd my-agents
farna-bootstrapper init
```

`init` creates (it accepts `--json` after the command name, like `generate` and `check`, emitting
one object on stdout):

```text
.farna/
  config.jsonc
  personas/
  resources/
    rules/
    permissions/
    mcp/
    skills/
    commands/
    hooks/
.gitignore        # .farna/local.jsonc, the journal, the generate lock, the staging namespace and OS metadata
.gitattributes    # .farna/** and every generated path, for every target, pinned to LF
```

The `--json` object is `schemaVersion`, `command` (`init`), `ok`, `exitCode`, `root`,
`configPath`, `created` and `updated` (the array of existing shared files this run appended to),
and `nextStep`. It reports the shared files as `created` or `updated`, and `created` names only the
directories this run actually created (a pre-existing directory is omitted); it never claims a path
it did not touch. `init` preserves the existing bytes and mode of `.gitignore` and `.gitattributes`,
appends only the missing lines, and restores both byte for byte if a later step fails.

Add one YAML file per persona under `.farna/personas/`, one Markdown file per rule under
`.farna/resources/rules/`, and one JSONC file per permission under
`.farna/resources/permissions/`. The workspace resource kinds live in their own directories:
`mcp/<id>.jsonc`, `skills/<id>/SKILL.md` (plus any extra files), `commands/<id>.md` and
`hooks/<id>.jsonc`. They are read and validated in this slice but require profile mode, so agent
mode refuses a persona that references one (F001):

```yaml
# .farna/personas/builder.yaml
kind: persona
id: builder
displayName: Builder
purpose: Writes code, runs the tests, and follows the house conventions.
model: standard
resources:
  - rule/house-style
  - permission/builder-default
```

```yaml
# .farna/personas/builder-python.yaml
kind: persona
id: builder-python
displayName: Python Builder
purpose: Writes Python and runs the Python checks.
extends: builder
resources:
  - rule/python-style
  - permission/python-tools
```

A persona may also declare **`mode`**, which selects its OpenCode agent mode: `primary` makes the
agent selectable as the main agent, `subagent` makes it callable only by another agent, and `all`
makes it both. `subagent` is the default when the key is absent. The value is source-derived and
composes with `extends`: a derived persona inherits its base's `mode`, and a child declaration
overrides it. Both OpenCode targets emit it; Claude Code has no primary/subagent distinction, so a
declared `mode` there is reported as `W117_PERSONA_MODE_IGNORED` (info) and no `mode` key is
written.

```yaml
# .farna/personas/builder.yaml — a primary agent on an OpenCode target
kind: persona
id: builder
displayName: Builder
purpose: Writes code, runs the tests, and follows the house conventions.
mode: primary
resources:
  - rule/house-style
  - permission/builder-default
```

```markdown
---
kind: rule
id: house-style
displayName: House style
---

Write the smallest change that satisfies the ticket.
```

```jsonc
// .farna/resources/permissions/builder-default.jsonc
{
  "kind": "permission",
  "id": "builder-default",
  "tools": {
    "read": "allow",
    "write": "allow",
    "edit": "allow",
    "shell": "allow",
    "task": "deny"
  }
}
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
farna-bootstrapper doctor            # validate the source; render and write nothing
farna-bootstrapper report            # print the measured capability matrix
farna-bootstrapper generate          # write the agent files and the lockfile
farna-bootstrapper generate --dry-run # print the plan, write nothing
farna-bootstrapper generate --adopt  # take ownership of existing outputs (see below)
farna-bootstrapper check             # prove the tree matches a fresh render
farna-bootstrapper generate --persona <id>  # OpenCode profile mode, overriding the config
farna-bootstrapper check --persona <id>      # check the same selection
```

The complete flag surface:

| Command | Flag | Behaviour |
|---|---|---|
| all | `--json` | emit one JSON object on stdout and suppress the human report; a typed failure also writes its one human line to stderr |
| all | `-v, --version`, `-h, --help` | print the compiled-in version or usage; neither needs the renderer |
| `init` | `--json` | the created/updated paths and the next step |
| `doctor` | `--json` | every validation that ran, every resolved persona and resource, and the warnings |
| `report` | `--json` | the measured capability matrix for every supported target |
| `generate` | `--dry-run` | print the plan and write nothing; `would-write` and `unchanged` are counted separately |
| `generate` | `--adopt` | take ownership of every existing planned managed output; required when the lockfile is missing |
| `generate` | `--persona <id>` | run profile mode as that persona; wins over `targets.<target>.active` and is not written back |
| `check` | `--persona <id>` | check the same selection |

`--persona` is the one CLI selection override. It selects profile mode and wins over
`targets.<target>.active`; see [Profile mode](#profile-mode).

`--json` is a per-command flag: place it after the command
(`farna-bootstrapper generate --json`), not before it. Every command then emits one machine-readable
object on stdout and no human report: a success is one object on stdout and nothing on stderr; a
typed failure is one object on stdout and its single human line on stderr. Every object carries
`schemaVersion`, `command`, `ok` and `exitCode`; a success object also carries the command's own
fields (`init` adds `root`, `configPath`, `created`, `updated` and `nextStep`), and a typed failure
also carries `code`, `subject` and `message`. `--dry-run` compares each managed path with the
working tree, so `unchanged` and
`would-write` are distinguished rather than every path being reported as a write. Its summary
counts the `would-write` files, not the size of the plan: a tree that already matches reports
`would write 0 file(s), N unchanged`.

`doctor` adds `target`, `mode`, `activePersona`, `notLive`, `configPath`, `counts`, `checks`,
`personas` and `warnings`; each persona carries its `chain`, `mode`, `model` and every resolved
resource with its `path`, `fromPersona` and `rank`. `report` adds `renderer` and `targets[]`, where
each target carries `id`, `status`, `agentReach`, `capabilities` (the seven cells, each with
`agent`, `workspace`, `basis`, `testId` and `consequence`) and `permissionKeys` (each with
`emission`, `code` and `consequence`).

A persona's rule text is joined into the body of its subagent, in canonical rule-id order, under a
`## displayName` heading. The rule body itself is never re-wrapped or re-indented. There is no
shared root rules file: the per-agent body is the only rule surface, so one persona's rules never
reach another persona's artefact.

## Targets

Exactly one target is configured per run. Switching target is one config edit:

```jsonc
// .farna/config.jsonc — the OpenCode 2.x target
{
  "schemaVersion": 1,
  "targets": { "opencode": {} },
  "models": {
    "standard": { "opencode": "anthropic/claude-sonnet-4-5" }
  }
}
```

```jsonc
// .farna/config.jsonc — the OpenCode 1.x target
{
  "schemaVersion": 1,
  "targets": { "opencodev1": { "active": "builder" } },
  "models": {
    "standard": { "opencodev1": "anthropic/claude-sonnet-4-5" }
  }
}
```

A model class maps per target, so a class used on `opencodev1` needs an `opencodev1` mapping (and
one used on `opencode` needs an `opencode` mapping). Configuring both OpenCode targets at once is
`F001`: the two write the same paths and one run has one lockfile and one mode plan.

All targets are rendered by the pinned rulesync renderer; the product derives the feature set from
the materialised source instead of passing `*`, and verifies the bytes the renderer produced before
writing any of them.

### Capability matrix

What this release actually carries, as measured by the tests that pin the emitted bytes and the
refusals. A cell has one of four values, and each has exactly one rendering in the `report` command:

| Value | Meaning | Glyph | Never |
|---|---|---|---|
| **native** | written into the emitted artefact | `[x]` | a claim that the harness obeys it at runtime |
| **emulated** | carried under a different category whose effect differs | `[~]` | counted as carried for a boundary capability |
| **dropped** | the target receives nothing; a declared reference is refused (`F001`) or reported (`W101`) | `[ ]` | silent |
| **unknown** | not measured in this release | `[?] not measured` | rendered as a tick |

`farna-bootstrapper report` prints this matrix for all three supported targets, as a human table or
as one JSON object with `--json`. It reads no source and writes nothing; the same data is what this
section documents.

| Capability | claudecode, agent | claudecode, workspace | opencode, agent | opencode, workspace | opencodev1, agent | opencodev1, workspace |
|---|---|---|---|---|---|---|
| `rule` | native | dropped [^claude-workspace] | native | native | native | native |
| `model` | native | dropped [^claude-workspace] | native | native | native | native |
| `permission` | native | dropped [^claude-workspace] | native | native | native | native |
| `skill` | dropped | dropped [^claude-workspace] | dropped | native | dropped | native |
| `command` | dropped | dropped [^claude-workspace] | dropped | native | dropped | native |
| `mcp` | dropped | dropped [^claude-workspace] | dropped | native | dropped | native |
| `hook` | dropped | dropped [^claude-workspace] | dropped | native | dropped | native |

[^claude-workspace]: Profile mode is not supported on `claudecode` in this release, so no
    workspace-level output is written for any capability.

The `permission` capability is one cell but a per-key measurement. `report` prints the key table
too, because the cell alone would hide where a key widens or refuses:

| Permission key | claudecode | opencode | opencodev1 |
|---|---|---|---|
| `read`, `edit`, `shell`, `task` | native | native | native |
| `write` | native | emulated (`W112`) | emulated (`W112`) |
| `network` | dropped (`F011`) | dropped (`F011`) | dropped (`F011`) |
| `mcp` (bare category) | dropped (`F011`) | not measured, refused (`F011`) | not measured, refused (`F011`) |

`write` on OpenCode is emulated, not native: OpenCode has no write category, so the rule lands as
`edit`, and an `allow` then also permits modifying existing files. `W112_PERMISSION_LOSSY` at high
severity names the widening, and a declaration is never silently weakened. A bare `network` or
`mcp` category has no mapping on any target, so it is refused (`F011`) rather than written as an
inert rule; the bare `mcp` category on OpenCode is recorded as **not measured** and is never claimed
as carried.

The OpenCode V1 columns record these differences from V2, each verified against rulesync 43.12.0
output in this repository's golden tests:

- **Agent frontmatter** — V1 keeps `name` and writes the per-tool `permission` map; V2 drops `name`
  and writes the ordered `permissions` array. A file carrying a V2 field is read as V2 by OpenCode
  2.x, which is why a V2 agent must not carry `name`.
- **MCP config** — V1 writes the flat `mcp.<name>` map with an explicit `enabled: true`; V2 nests
  servers under `mcp.servers` and omits an enabled server's toggle.
- **Commands** — V1's command frontmatter spells `subtask` and a separate `variant`; V2 spells
  `subagent` and joins the variant onto `model`. This product authors only `description`, so the
  emitted command frontmatter is the same on both; a `subtask`/`variant` field is refused at the
  source boundary rather than being silently written in the wrong spelling.
- **Hooks plugin** — V1 writes the `RulesyncHooksPlugin` module, which OpenCode 2.x does not run;
  V2 writes the `{ id, setup }` plugin, which OpenCode 1.x does not run.

Two details matter more than the table:

- **OpenCode's workspace kinds are not an agent-mode loss warning.** A workspace emission would give
  every persona the declaring persona's MCP server, skill, command or hook, with no per-recipient
  record and no opt-out. That is not a capability the author declared for those personas, so agent
  mode refuses the reference and points at profile mode instead of emitting it. Profile mode carries
  the live persona's kinds; a hook OpenCode cannot represent (`session-end`, or a matcher on a
  non-tool event) is reported as `W101_CAPABILITY_DROPPED` at high severity and is not emitted.
- **Claude Code's workspace kinds are absent from this release.** `claudecode` does not carry
  `mcp`, `skill`, `command` or `hook` at any level yet; a reference is refused rather than silently
  losing it. Profile mode on `claudecode` is later work.

A persona `mode` is documented separately from these seven capabilities: it is native on both
OpenCode targets and has no Claude Code field (`W117_PERSONA_MODE_IGNORED`). The opt-in Claude Code
`tools` allow-list has no OpenCode equivalent and is refused there; see [Permissions](#permissions).

The full 71-target matrix and the generated `docs/capability-matrix.md` page are not in this
release. `report` prints the measured matrix for the three supported targets today. See
[What this slice does not do](#what-this-slice-does-not-do).

### Output layout

```text
claudecode, agent mode:
  .claude/agents/<id>.md            one whole file per persona

opencode or opencodev1, agent mode:
  .opencode/agents/<id>.md          one whole file per persona

opencode or opencodev1, profile mode (active: <id>):
  opencode.jsonc                    the active persona's MCP servers, merged into the user's own keys
  .opencode/agents/<id>.md          only the active persona
  .opencode/skills/<skill-id>/**    the active persona's skills and their extra files
  .opencode/commands/<id>.md        the active persona's commands
  .opencode/plugins/rulesync-hooks.js   the active persona's carried hooks
                                      (skills, commands and hooks are under .opencode/, not the root)

all targets:
  .farna/lock.json                  the manifest and the source-derived warnings
```

Every path is conditional on a declaration: a persona with no MCP server emits no
`opencode.jsonc`, one with no hooks emits no plugin, and one with no skills has no skill tree.
Agent mode writes none of the workspace paths. `check` computes the expected set independently of
what the renderer reports, so a dropped or invented file is refused rather than written.

### Profile mode

OpenCode carries MCP servers, skills, commands and hooks at the **workspace** level, not per agent.
In agent mode a workspace emission would give every persona the declaring persona's resource, with
no per-recipient record and no opt-out. That is not a capability the author declared for those
personas, so the four kinds require profile mode: exactly one persona is live, and it owns the
workspace. Agent mode still refuses such a reference with `F001_INVALID_CONFIG`, naming the
resource, the declaring persona and "requires profile mode"; nothing is written.

Select profile mode in the config:

```jsonc
// .farna/config.jsonc
{
  "schemaVersion": 1,
  "targets": {
    "opencode": { "active": "builder" }
  }
}
```

Or override the committed selection for one run:

```sh
farna-bootstrapper generate --persona reviewer
farna-bootstrapper check    --persona reviewer
```

`--persona` wins over `targets.<target>.active`. A persona that does not exist is
`F001_INVALID_CONFIG` naming the config field or `--persona`; the tool never picks a persona for
you. Agent mode is the default when no active persona is set.

**The invariant is one persona per workspace.** In profile mode only the active persona is
materialised and verified: no other persona's agent file, MCP server, skill, command or hook is
emitted, and the containment gate accepts only the active set. Every persona is still resolved, so
a broken declaration anywhere in the source is still refused; only emission is scoped to the live
persona. The lockfile records one `personas[]` entry, `mode: "profile"`, `activePersona: "<id>"` and
`notLive: [<every other persona>]`; in agent mode `mode` is `"agent"`, `activePersona` is `null`
and `notLive` is empty. `generate` and `check` print the not-live set, and `--json` carries it as
`notLive`, so a deactivated persona is never silent.

Selecting profile mode with `active` or `--persona` when the live persona declares no capability
that *requires* it (an MCP server or a hook, which OpenCode carries only at the workspace level) is
a choice, and it is reported as `W109_PROFILE_BY_CHOICE` at info severity. A skill or command is
content the target could in principle drop, so it does not force the mode.

**The profile is the repository root.** It is never a cache directory and never a subdirectory
below another config. The exact paths are in [Output layout](#output-layout).

Profile mode is supported for both OpenCode targets (`opencode` and `opencodev1`). `claudecode`
refuses an `active` value or `--persona` with `F001_INVALID_CONFIG`: its only workspace-only
capability is `command`, a content capability that does not force a profile, so profile mode there
is later work. Accepting the setting and ignoring it would be a silent no-op.

A hook OpenCode cannot represent (`session-end`, or a matcher on a non-tool event) is reported as
`W101_CAPABILITY_DROPPED` at `high` severity and is not emitted; it is never silently omitted.

#### Orphan handling

A persona switch, a removed resource or a target edit leaves output the committed lockfile records
but the current source no longer produces. `check` reports every such recorded path as
`F007_DRIFT` drift with kind `unexpected`. An unrecorded file is ordinarily ignored, because it
belongs to the user.

`check` also compares a `configDigest` recorded in the lockfile: a change to the config or to **any**
persona or resource file is drift even when the live persona renders no different byte, so an edit
to a non-live persona's declaration cannot hide. The digest covers the **raw** `config.jsonc`
bytes as well as the parsed value, so a comment or whitespace edit in the config is drift exactly
like a comment edit in a persona file.

`generate` may remove a recorded orphan, under four guards:

1. it must exist and be a relative, escape-free path in a managed location — one of
   `.claude/agents/`, `.opencode/agents/`, `.opencode/commands/`, `.opencode/skills/`,
   `.opencode/plugins/`, or a target's whole root config file (`opencode.jsonc`). A recorded path
   that is already **absent** is simply dropped from the new lockfile; the managed-location guard
   applies only to a path that exists, so the action it prints can always be carried out;
2. it must still be a **regular file**; a symbolic link is refused (`F003`) and never followed;
3. its bytes must still equal the SHA-256 the lockfile recorded. The check is repeated immediately
   before the `rm`, so a file changed between the preflight and the removal is refused rather than
   deleted. A file edited since the last generate is refused with `F007_DRIFT`: ownership can no
   longer be proven, so it is not deleted;
4. it must be recorded. An unrecorded file is the user's and is never removed.

A structured entry (`opencode.jsonc`) owns only its `mcp` key. When the source no longer declares
an MCP server, `generate` deletes only that key in place: a file that still carries the user's own
keys is kept, with its comments, and the record is dropped; a file that holds nothing but the owned
key is removed. Once the user has removed the owned key itself the record is dropped and the file
left alone.

The whole orphan set is preflighted before anything is written, so a refusal leaves the tree
untouched. Removals happen before the new managed set is committed: a commit that then fails names
the removals it already made, so the error never claims "nothing was written" for a tree that is
partially updated. An empty directory left after removing a skill's last file is not removed: the
contract is to remove recorded regular files, not directories.

### A missing lockfile: refuse, then adopt

The lockfile is the only proof that a path is this tool's output. When it is absent, a file at a
planned path could be this tool's earlier render or the user's own file, and the tool has no way to
tell. It therefore **refuses** rather than guessing from a file name: if `.farna/lock.json` is
missing and any planned managed output already exists, `generate` and `check` fail with
`F007_DRIFT` naming those outputs and the action `run generate --adopt`.

`generate --adopt` is the explicit adoption. It takes ownership of every existing planned managed
output: `opencode.jsonc` is merged in place so only the owned `mcp` key changes and the user's keys
and comments survive, every other planned file is overwritten with the fresh render, and the
lockfile records the result. A file **not in the plan** is neither adopted nor removed. `check`
never adopts; it only tells the user to run `generate --adopt`.

The trade-off is deliberate: with no lockfile the tool does not scan for stale renders by path. A
stale output that is not recorded and not in the plan is the user's responsibility; naming a file
is not proof that this tool wrote it.

The one unrecorded path `check` still reports is an extra file inside a **skill directory** this
tool owns (recorded or planned at `W107_OUTSIDE_OWNERSHIP`, never deleted), which is a recorded-path
question rather than a name guess. A file under a name no declaration would emit
(`.opencode/commands/custom.md`, `.opencode/skills/custom/`) is genuinely the user's and is not
reported.

MCP `env` and `headers` values are references only. A resource declares
`{ "fromEnv": "EXAMPLE_TOKEN" }`; the materialiser writes rulesync's canonical `${EXAMPLE_TOKEN}`.
A literal value in a credential position is `F002_SECRET_LITERAL` and is never echoed. An MCP
`http` URL may not carry userinfo (`F002`, never echoed); a credential-shaped query parameter
(`token`, `api_key`, `apikey`, `access_token`, `secret`, `password`) is reported as
`W115_CREDENTIAL_IN_URL` and never echoed either. A stdio `command` is the program only: whitespace
and control characters are refused (F001) with a message to put the arguments in `args`.

`args` accepts literals, because a command genuinely needs them (`-y`, `serve`, a path). A literal
that *looks like a credential* (`sk-`, `ghp_`, `glpat-`, `npm_`, `AKIA`, a JWT, or a long token-shaped
string with letters and digits) is reported as `W116_SECRET_IN_ARGS` at high severity, naming the
argument's position and never echoing the value: it would otherwise be written verbatim into
`opencode.jsonc`. A `{ "fromEnv": "NAME" }` reference inside `args` cannot be expressed — rulesync
43.12.0 accepts only string arguments and copies them into the emitted command verbatim, so the
reference would reach the server as the unexpanded text `${NAME}` — and is refused (F001) with the
supported alternative: put the credential in `env` or `headers`.

The workspace resource kinds are **not** carried by `claudecode` either. A persona that references
one is refused (F001) rather than silently losing it.

## Composition

`extends` names at most one base persona. Resolution is:

1. Resolve `extends` recursively, depth at most 32; a cycle, a self-extension or a missing base
   is refused (F001) and the cycle message names the whole path.
2. The base persona's rules and permissions are unioned into the child, by `(kind, id)`.
3. The child's own `resources` are added in declaration order. Rule bodies are deduplicated by
   id; permissions are merged by category, and the stricter value wins.
4. The model is inherited from the base or set on the persona. Two different concrete models in
   one composed set are a conflict (F005), never a silent override.
5. The composed persona's body is both rule sets, and its permission entries are the union. In
   the example above `builder-python` carries both rule markers and not the reviewer's, because
   the reviewer's rules were never in its chain.

`resources` may be empty. A persona with no rules has an empty composed body: its artefact carries
only its frontmatter, so a permission-only persona (a locked-down reviewer with no prose) is valid
and generates cleanly.

A composed persona is one new name. There are no multi-parent unions and no per-target branches
in the source.

## Permissions

The canonical categories are `read`, `write`, `edit`, `shell`, `network`, `mcp`, `task` and `*`.
They are validated at plan time and mapped to the target's own form before anything is written:

| Category | Claude Code entry | OpenCode 2.x record | OpenCode 1.x map |
|---|---|---|---|
| `read` | `Read` / `Read(P)` | `{action: read}` | `read` |
| `write` | `Write` / `Write(P)` | `{action: edit}` (folds into `edit`, W112) | `edit` (folds into `edit`, W112) |
| `edit` | `Edit` / `Edit(P)` | `{action: edit}` | `edit` |
| `shell` | `Bash` / `Bash(P)` | `{action: shell}` | `bash` |
| `task` | `Agent` / `Agent(P)` | `{action: subagent}` | `task` |
| `network` | none | none | none — refused (F011, exit 3) |
| `mcp` (bare) | none | none | none — refused (F011, exit 3) |
| `*` | expands to every category | same | same — refused (F011), because it covers `network` |

On OpenCode 2.x the records are an ordered array of `{ action, resource, effect }`. `bash` is
emitted as `shell` and `task` as `subagent`. OpenCode documents last-match-wins, so order is
semantic: the catch-all is emitted first, and pattern resources keep their source declaration
order. Sorting by codepoint could put an earlier allow after a later deny and silently turn a deny
into an allow. The permission digest is order-sensitive for the same reason.

On OpenCode 1.x the same resolved map is written as the per-tool `permission` object, with
`shell` under OpenCode's own key `bash` and `task` under `task`; both OpenCode targets fold `write` into
`edit` and refuse `network` and a bare `mcp` before anything is materialised. `write` has no
OpenCode category on either target: every write-derived `allow` that no edit declaration covers is
reported as `W112_PERMISSION_LOSSY` (HIGH), including when an unrelated edit allow exists. A record
whose emitted effect is deny is never reported: it narrows, and a stricter rule must never be
presented as a loss. `ask` is emitted as `deny` on all targets and reported as
`W111_ASK_DOWNGRADED`, because none of them has a measured ask surface.

### Allow-list vs deny-list

Claude Code's per-agent `tools` field is an **allow-list**: naming three tools removes every tool
it does not name, including `Glob`, `Grep`, `WebFetch`, `TodoWrite`, `NotebookEdit` and any tool
this product does not model. The default is therefore a **deny-list**: `allow` entries emit
nothing (the tool is available unless denied), while `deny` and an `ask` downgraded to `deny` are
emitted into `disallowedTools`. A partial allow set can never silently narrow a persona.

A permission resource may opt in with `"allowlist": true`. The resolved persona then emits the
ordered `tools` allow-list and a `W113_ALLOW_LIST_NARROWS` warning names examples of the unmodelled
tools the narrowing removes (the product does not enumerate every harness tool). The mode is persona-scoped: if any contributing resource opts in, the union of
its resolved `allow` entries becomes the allow-list. `check` applies the same rule, so a renderer
that invents or drops `tools` is refused either way. If the opt-in resolves to no `allow` entry
(every category is denied, or a deny removed the only allow), `tools` is omitted and W113 reports
that the opt-in had no effect, naming the categories that removed it; emitting `tools: []` would
remove every tool. The persona's permission digest records that same effective value.

A pattern is resolved against its category before it is emitted: if the category's winning value is
`deny` (including an `ask` downgraded to `deny`), an `allow` pattern under it is not emitted and the
drop is reported (W106) naming the pattern. Emitting both would leave the harness, not this tool,
deciding which of two contradictory entries wins. Every other category is native and maps 1:1 onto a
distinct tool, so there is no W112 on Claude Code. When two permission resources disagree on a
category, the stricter value wins and the disagreement is reported (W106). On Claude Code both
arrays are sorted alphabetically and every entry starts with the harness's capitalised tool name.

A pattern key that is a canonical array index (`"0"`, `"1"`, `"10"`, ...) is refused at the source
boundary (F001). JavaScript enumerates an object's array-index keys first, in ascending numeric
order, before every other key in declaration order, so a numeric pattern would silently move ahead
of the patterns declared before it. Order is semantic (OpenCode is last-match-wins) and the digest
would be identical for both spellings, so the tool refuses the key instead of emitting an order the
source did not declare. Spell the resource as a non-numeric pattern such as `"**/10/**"`, or choose
another key that is not a bare integer.

An OpenCode persona may not opt into the Claude Code `tools` allow-list. OpenCode's records are a
deny-list and cannot name every unmodelled tool, so `"allowlist": true` is refused (F001) on that
target rather than silently ignored.

Only harness-specific category names reach the renderer source tree; a product category name is
never written there, and a test asserts it.

Warnings are printed by `generate` and `check`. The warning set covers every resolved persona, not
only the live one: each warning names its persona, so a declaration an inactive persona makes is
still visible in profile mode. Source-derived warnings are recorded in `.farna/lock.json`.
`W107_OUTSIDE_OWNERSHIP` is reported by `check` as a drift item rather than a source warning: it
describes the working tree (an extra skill file), not the source. `W114_RENDERER_INTEGRITY_UNVERIFIED`
is a runtime verification result about the machine, so it is printed but deliberately not recorded;
recording it would make two machines with identical sources produce different lockfile bytes.

## Warnings and exit codes

### Warnings

A warning is a report, not a failure: it never changes what is rendered. A run that emits one still
exits `0` unless the warning records a refusal (which is a typed error, not a warning). The severity
is part of the code's definition, never set by a flag.

| Code | Default severity | What it reports |
|---|---|---|
| `W101_CAPABILITY_DROPPED` | high for a boundary capability, medium for content | A resolved capability the target cannot carry was not emitted. In profile mode this is a hook OpenCode cannot represent (`session-end`, or a matcher on a non-tool event). Never a silent omission. |
| `W106_DENY_WINS` | medium when the losing value is `allow`, otherwise info | Two permission resources disagreed on a category; the stricter value won, and the disagreement (and what it removed) is named. |
| `W107_OUTSIDE_OWNERSHIP` | low | An unrecorded file is inside a skill directory this tool owns. `check` reports it as drift; `generate` never deletes it. |
| `W109_PROFILE_BY_CHOICE` | info | Profile mode was selected although the live persona declares no capability that requires it (an MCP server or a hook). Agent mode is the default. |
| `W111_ASK_DOWNGRADED` | medium | An `ask` permission was emitted as `deny`, because no target has a measured ask surface. |
| `W112_PERMISSION_LOSSY` | high | On OpenCode, `write` folds into `edit`; a write-derived `allow` that no edit declaration covers is lost. A deny is never reported, because a stricter rule is not a loss. |
| `W113_ALLOW_LIST_NARROWS` | medium | A permission resource opted into the Claude Code `tools` allow-list, which removes every tool the product does not model. Examples of the removed tools are named; an opt-in that resolves to nothing is reported as having no effect. |
| `W114_RENDERER_INTEGRITY_UNVERIFIED` | medium | No npm lock record at the install root supplied the renderer's tarball integrity. The pinned version is still enforced; this is a provenance gap, never a clean pass. |
| `W115_CREDENTIAL_IN_URL` | high | An MCP `http` URL carries a credential-shaped query parameter (`token`, `api_key`, `apikey`, `access_token`, `secret`, `password`). The value is never echoed. |
| `W116_SECRET_IN_ARGS` | high | An MCP `args` literal looks like a credential (`sk-`, `ghp_`, `glpat-`, `npm_`, `AKIA`, a JWT, or a long token-shaped string). The value is never echoed; put the credential in `env` or `headers` instead. |
| `W117_PERSONA_MODE_IGNORED` | info | A persona declares `mode`, which Claude Code cannot carry: it has no primary/subagent mode. The persona and target are named and no `mode` key is written; the agent file is otherwise emitted in full. |

### Exit codes

| Exit | Meaning | Codes |
|---|---|---|
| `0` | success; warnings are allowed | — |
| `1` | invalid input, an unsafe path, or drift | `F001_INVALID_CONFIG`, `F002_SECRET_LITERAL`, `F003_PATH_UNSAFE`, `F007_DRIFT` |
| `2` | a conflict between declarations | `F005_CONFLICT` |
| `3` | a requested capability is refused | `F011_PERMISSION_UNMAPPED` |
| `4` | the renderer lost or invented declared content | `F008_DECLARED_NOT_EMITTED` |
| `5` | the render or the write failed | `F009_RENDER_FAILED`, `F010_RENDERER_MISMATCH`, `F012_WRITE_FAILED` |

`check` uses exit `1` for drift and carries `F007_DRIFT` in its payload with the first drifted path
as `subject`; drift is a result, not an exception, so it is absent from the exception table. A
usage error (an unknown command or option) exits `1`. Under `--json` the human report is
suppressed: a success is one object on stdout and nothing on stderr; a typed failure is one object
on stdout and its single human line on stderr.

## Layout

```text
src/
  cli/            Commander wiring, the five commands, and the error boundary
  config/         strict JSONC config schema and loader
  source/         YAML personas; markdown rules, skills and commands; JSONC permissions,
                  MCP servers and hooks; strict frontmatter and reference-only secrets
  compose/        mode resolution, extends resolution, resource union, deny-wins merge, digests
  permissions/    the canonical vocabulary and the Claude Code and OpenCode mappings
  matrix/         the measured capability snapshot and its F010 integrity guard
  materialise/    persona and workspace resources -> rulesync source tree
  render/         port.ts (the seam), upstream.ts (the only rulesync import),
                  identity.ts (installed vs pinned renderer), prepare.ts (the pipeline),
                  stage.ts (the disposable stage), commit.ts (the write), staging.ts,
                  orphans.ts (recorded-orphan preflight and removal), generate-lock.ts
                  (the atomic lock directory), structured.ts (in-place, key-level
                  ownership of opencode.jsonc), root-cleanliness.ts (skill-tree extras)
  verify/         containment and cross-persona isolation gates
  lock/           lockfile construction and validated reading
  core/           constants, typed errors, paths, strict UTF-8 reads, canonical JSON
  report/         text and JSON output, warning records, the capability report
tests/
  fixtures/demo/      the demo fixture: two personas, two rules, no permissions
  fixtures/composed/  builder, builder-python (extends builder) and reviewer, with permissions
  fixtures/opencode/     the OpenCode 2.x fixture: rules, permissions and the files for the refused kinds
  fixtures/opencode-v1/  the OpenCode 1.x fixture, same shape on the V1 target
  fixtures/profile/      OpenCode 2.x profile mode: two personas with distinct MCP, skill, command and hook
  fixtures/profile-v1/   OpenCode 1.x profile mode, same source on the V1 target
  golden/                every target's pinned emitted bytes, both OpenCode majors included
  unit/               composition, permissions, fake and mutating renderer gates, loader, init,
                      check, paths, profile mode and orphan removal
  integration/        the real pinned renderer
  cli/                the built CLI: exit codes, JSON envelopes and drift output
scripts/              CI gates: the minimum test count, real-renderer suites and tarball contents
```

`.farna/lock.json` records `schemaVersion`, `product` (name and version), `target` (`claudecode`,
`opencode` or `opencodev1`), `mode` (`agent` or `profile`), `activePersona` (the persona id in profile mode, `null`
in agent mode), the `renderer` identity, each **live** persona's composition base and resolved
resource ids (each with the persona that contributed it, across every loaded kind), a persona
digest, an order-sensitive permission digest, every source-derived warning, and the path, size and
SHA-256 of every managed file. It does **not** list
itself: the lockfile is built from the managed files before its own record is appended, so its own
bytes are deliberately
absent from `files`. It contains no timestamps, hostnames or absolute paths. A lockfile written
by an earlier version that recorded `W114` in `warnings[]` is repaired by one `generate`, which
drops the runtime record and rewrites the same source-derived document.

The `renderer` record is the build's **pin** (`RENDERER_PIN`), not the integrity the local package
manager wrote, and it is what `check` compares the installed package against. Two machines that
both verified their install, and a machine that could not verify its own, therefore produce
byte-identical lockfiles for the same source: `W114_RENDERER_INTEGRITY_UNVERIFIED` is reported in
the command output, never recorded in this artefact. A lockfile that recorded it made a runtime
verification result part of the byte comparison, so `check` reported `F007_DRIFT` on
`.farna/lock.json` between a verified and an unverified machine even though no source had changed.

## Determinism

The generated bytes are the product, so they must not depend on where or when the command ran.

- **The lockfile is source-derived.** It records the product version, the target and mode, the live
  persona (and the not-live set), each persona's composition and digests, the source warnings, and
  each managed file's path, size and SHA-256. It records no timestamp, hostname, absolute path, user
  name or process id.
- **Ordering is canonical.** Personas and resources are sorted by kind and codepoint id before
  hashing or writing. Permission records are the one deliberate exception: they keep source order
  because OpenCode is last-match-wins, so the digest is order-sensitive there too.
- **The renderer is pinned.** `rulesync` is pinned to exactly `43.12.0` with a tarball integrity (see
  [The renderer boundary](#the-renderer-boundary)). The lockfile records the pin, not the integrity
  the local package manager happened to write, so two machines that both verified their install -
  and one that could not verify its own - produce the same lockfile bytes for the same source.
- **Line endings are pinned.** `init` adds `/.farna/**` and every generated path to `.gitattributes`
  with `text eol=lf`, so a Windows checkout does not change a source byte (and therefore
  `configDigest`) or make `check` report drift the source never declared. This repository pins its
  own `.farna/**` tree the same way.
- **`check` is a byte comparison.** It re-renders into a temporary directory and compares the exact
  bytes (or, for `opencode.jsonc`, the owned key's value). A file that exists is not a file that
  matches.

The repository's own suites include golden byte comparisons and a two-root determinism test. Two
clean runs of the same source on one machine produce identical bytes and an identical lockfile;
cross-machine determinism follows from the same rules, and CI runs on Linux.

## The renderer boundary

`src/render/port.ts` defines `RenderTarget`. `src/render/upstream.ts` is the only module that
imports `rulesync`, and `src/cli/main.ts` is the only place that binds the real implementation.
Unit tests use an independent fake renderer, so the failure modes the port exists to catch can be
exercised without the network or the real renderer.

`rulesync` is pinned to exactly `43.12.0` with a tarball integrity. The lockfile records that pin,
and `check` compares it with the installed package before any byte comparison. The renderer
identity policy has three parts:

1. **Version — enforced.** A different name or version fails `F010` with exit `5`. This runs first,
   so a missing integrity can never let a substituted renderer pass.
2. **Integrity — best effort, from two records.** The installed integrity is read from exactly two
   npm records at the install root (the nearest ancestor of the product package that owns a
   `node_modules` directory): `node_modules/.package-lock.json` and `package-lock.json`. The
   `packages` map is searched for the renderer's entry under any key ending in
   `node_modules/<renderer>` (a scoped name keeps its scope in the key). A nested install records
   it as `node_modules/farna-bootstrapper/node_modules/rulesync`. When more than one entry matches,
   the one nested under farna-bootstrapper's own package wins, then the shallowest, then the
   earlier record. In a hoisted workspace the renderer is at the workspace root, so that root is
   the install root and its record is read; the search never leaves the install root beyond that,
   so a workspace root above it, a parent monorepo or a sibling package records a different copy
   and is never read, and cannot refuse a healthy install with a foreign integrity or verify one
   it did not examine. A string integrity that was found is compared exactly with the pin; a
   different one is `F010`, including when a shared record's matching entry belongs to another
   package: only the pinned tarball passes.
3. **Unverifiable — named, never silently passed.** A record that exists but cannot be read, is a
   symlink or is not a regular file, or is above the 64 MiB npm-record bound, is refused `F010`
   naming the record, even when the other supported record is usable. Only a genuinely absent
   entry in the two supported records, or an entry with no string integrity, is
   `W114_RENDERER_INTEGRITY_UNVERIFIED`: the version check still applies, the run continues, and
   the warning names whether no record was found or the record had no integrity. The pin is **not**
   substituted for a missing integrity and the tool never claims a clean integrity pass it could
   not make.

The 64 MiB npm-record bound is deliberately separate from the 4 MiB bound on `.farna/lock.json`:
npm's record scales with the dependency tree, so a legitimate monorepo lockfile is several
megabytes. The check never degrades a known integrity to a version-only comparison. Because the
lockfile records source-derived state only, a machine that could not verify its install does not
change its bytes: `W114` is reported by the command, and verified and unverified machines produce
the same lockfile for the same source, so `check` agrees across them.

The renderer is imported **in-process**. The pin is provenance, not a sandbox: it ties the
committed bytes to a published tarball when the integrity is verifiable, but a package patched in
place with the same `package.json` and integrity is not detected, and an unverifiable install is
reported rather than blocked (see the residual list). The product never uses rulesync's `--delete`;
cleanup is ownership-scoped, and this slice never deletes a user file.

The renderer call is hermetic: its working directory is the disposable stage and its `configPath`
is a file inside that stage, so an ambient `rulesync.jsonc` (or `rulesync.local.jsonc`) in the
caller's directory cannot flip `dryRun`, `delete` or `check`. Those three options are also pinned
explicitly.

Every source directory and output path used by `generate`, `generate --dry-run` and `check` is
checked with `lstat` before use. The write and dry-run paths refuse a symbolic link wherever it
appears: `.farna`, its subdirectories, `config.jsonc`, any ancestor of a managed output path
(including `.claude` symlinked inside the repository), and a managed file itself. `check` reports
a symlinked managed file as drift instead of following it. The dry-run plan goes through the same
guard as the write path, so it cannot report a plan the real command would refuse.

`generate` preflights the whole set, sweeps its own staging namespace, stages each file as a hidden
`.<target>.farna-tmp-<pid>-<uuid>` sibling on the same filesystem, and renames only after every
write has succeeded. A caught failure before the first rename removes the staging files and the
directories this run created; if a directory cannot be removed, the diagnostic names it rather than
claiming a clean tree. A failure between renames restores the files already replaced and names any
file it could not restore. A crash or kill between renames can still leave a mixed tree; see
[Residual risks and known gaps](#residual-risks-and-known-gaps). `init` preflights `.gitignore`
before creating anything, preserves its line ending, writes the new file with `O_EXCL` under an
unpredictable name and proves it is a regular file before renaming it over `.gitignore`, and removes
what it created if it subsequently fails.

## Examples

Three complete source trees live in [`examples/`](examples/). All are exercised by the test suite:
the built CLI generates each one in a temporary copy and `check` must exit `0`.

- [`examples/claude-code/`](examples/claude-code/) - two personas (`builder`, `reviewer`) in agent
  mode on the `claudecode` target, with two rules and a real read-only reviewer restriction. Run it
  with `node ../../dist/cli/main.js generate` then `check` from that directory.
- [`examples/opencode-v2/`](examples/opencode-v2/) - profile mode on the `opencode` target (OpenCode
  2.x, `@opencode/cli`): one live persona (`builder`) that owns the workspace, with a rule, a
  permission set, one MCP server, one skill, one command and one hook, plus a second persona that is
  resolved but not live. The MCP credential is an environment reference, not a literal.
- [`examples/opencode-v1/`](examples/opencode-v1/) - the same source tree on the `opencodev1` target
  (OpenCode 1.x, `opencode-ai`): the V1 agent frontmatter, the flat `mcp` map, the V1 command
  frontmatter and the `RulesyncHooksPlugin`. It writes the same paths as the V2 example.

Each example has its own README with the exact commands and the files it writes. None commits
generated output; the example is the source tree.

## Where to look for a decision

This README is the user-facing contract and the record of the behaviour it covers. Each target's
section, the [Capability matrix](#capability-matrix), [Warnings](#warnings) and
[Residual risks and known gaps](#residual-risks-and-known-gaps) answer the questions a separate
design note would otherwise answer. If a behaviour is not explained anywhere here, open an issue
rather than inferring it from a generated file. See also [CONTRIBUTING.md](CONTRIBUTING.md) for
where a change belongs and which gates it must pass.

## What this slice does not do

Deliberately out of scope:

- `agent with loss` and `refuse` as plan outcomes; profile mode on `claudecode`; rendering more
  than one configured target per run; every target other than `claudecode`, `opencode` and
  `opencodev1`; the full 71-target capability matrix and the generated `docs/capability-matrix.md`
  page (the `report` command prints the measured matrix for the three supported targets today)
- model resources (a model is the persona's `model` class in this slice)
- carrying `mcp`, `skill`, `command` or `hook` on any target in **agent** mode; profile mode is
  where those workspace capabilities belong, and agent mode still refuses them
- `patch` and `replaceWith` on a persona resource reference; `targets` filters on personas and
  resources; `--strict`; `--accept-config` gating; `.farna/local.jsonc`
- removing a recorded orphan that is not in a managed location: a path outside `.claude/agents/`,
  `.opencode/` or `opencode.jsonc` is refused rather than deleted, because ownership cannot be
  proven; an empty directory left after a skill's last file is removed is not swept
- region ownership (`CLAUDE.md`, `AGENTS.md`); `opencode.jsonc` is the only structured file, and the
  only key it owns is `mcp`. Every other managed path is a whole file or a whole tree

Recursive deletion is limited to directories the tool created. There are three sites:
`src/render/stage.ts` removes the disposable `mkdtemp` stage, and `src/render/generate-lock.ts`
removes the lock directory renamed aside on reclaim and again on release. Each deletes only a
directory this tool created; no user content is recursively deleted.

## Residual risks and known gaps

These are deliberate limits of the current controls, stated rather than implied away:

- **TOCTOU between preflight and write.** Every ancestor is `lstat`'ed before the write, but a
  symlink swapped in between that check and the `mkdir`/`rename` is not detected. Node exposes no
  `openat`/`O_NOFOLLOW` equivalent, so closing this needs a separate seam.
- **Crash between renames.** A caught rename failure restores the files already replaced and names
  any it could not restore. A process kill or power loss between two renames can leave a mixed tree
  (some new artefact files, a stale lockfile). Re-running `generate` replaces the managed set and
  rewrites the record; `check` reports the drift.
- **Renderer file-content tampering.** The renderer is imported in-process and the identity check
  reads the installed package's version and the npm-recorded tarball integrity. A renderer patched
  in place with the same `package.json` and the same tarball integrity is not detected. The pin is
  provenance, not a sandbox.
- **Stage cleanup.** The stage lives under the canonical temporary root; the containment check uses
  `path.relative`, so a Windows checkout recognises its own stage (a hardcoded `/` used to refuse it
  and leak the directory), and creation failures after `mkdtemp` still reach the cleanup. If the
  stage cannot be removed (for example a renderer left an unreadable subdirectory in it), the
  cleanup failure is a warning naming the leftover path and never replaces the renderer's own error.
- **Lockfile read.** `.farna` must be a real directory and `.farna/lock.json` a real regular file of
  at most 4 MiB, opened with `O_NOFOLLOW`. A symlink, FIFO or oversized file is a typed refusal
  rather than a follow or a hang. A lockfile that is **present but malformed or of an incompatible
  version** is a typed F001 naming `.farna/lock.json` with the delete-and-regenerate recovery; it is
  never treated as "no records". A lockfile written before profile mode existed (no `mode`, no
  `activePersona`) is still accepted and normalised to agent mode, so its recorded paths are not
  silently forgotten.
- **One `generate` at a time.** `.farna/.generate.lock` is a **directory** created with `mkdir`
  (atomic on every supported filesystem), its owner recorded in `pid`, around the whole read →
  plan → remove → commit sequence, and released in a `finally`. A second live run is a typed F001
  ("lock held"). A lock whose owner pid is dead, or that is older than the age bound, is reclaimed
  by renaming it aside (only one reclaimer can win) and retrying the `mkdir`. A non-directory at the
  lock path is a typed error, never "another generate is running".
- **Generated modes are explicit.** Managed files are created `0644` and managed directories
  `0755`, then re-asserted with `chmod`; the process umask no longer decides whether generated
  output is group- or world-writable.
- **Staging leftovers.** A killed `generate` can leave `.<target>.farna-tmp-*` siblings. They are
  ignored by `check` and swept at the start of the next `generate`; a leftover in a directory the
  next plan does not touch (an unplanned directory) is not swept and is left on disk. Removal is
  best-effort and a leftover is never a managed path.
- **Orphan removal is preflighted, not transactional.** The whole orphan set is checked before the
  first write, and removals run before the new set is committed. A filesystem failure while
  removing, or a commit failure after a removal, leaves a mixed tree: the failure message names the
  paths already removed, `check` reports them, and re-running `generate` completes the switch. A
  recorded orphan replaced by a directory, a symlink or edited bytes is refused rather than guessed
  at, and must be removed deliberately. The bytes are re-read and re-hashed immediately before each
  `rm`: a file changed between the preflight and the removal is refused rather than deleted.
- **An empty directory is left after a skill's last file is removed.** Only recorded regular files
  are removed; the now-empty `<skill>/` (or `scripts/`) directory is harmless and carries no
  declaration.
- **The per-agent `mode` is source-derived, not implied by the render mode.** A persona's declared
  `mode` (default `subagent`) is emitted on both OpenCode targets; profile mode does not promote the
  live persona implicitly. Claude Code has no primary/subagent mode, so a declaration there is
  reported (`W117`) and no `mode` key is written.
- **No coverage gate.** There is no coverage provider or threshold in this slice. CI runs lint,
  type-check, tests (with a minimum count and real-renderer suite assertions), a dependency audit at
  `moderate`, and a published-tarball check.
- **Windows-specific test skips.** Four classes of test cannot run on Windows: the symlink
  regression suites (creating a symbolic link needs a privilege the runner does not grant), the
  POSIX file- and directory-mode assertions (mode bits are not meaningful on NTFS), the FIFO cases
  (Windows has no `mkfifo`-equivalent endpoint to create one), and the install-layout suite (its
  fixtures model a hoisted or nested install with symlinks). CI runs all of them on Linux; the
  guard code itself is platform-independent.
- **Unrecorded files are not drift.** With a lockfile present, `check` compares the paths in the
  fresh plan (missing or changed) and the paths the committed lockfile records (an output the source
  no longer produces). A file the user keeps in a managed directory is not this tool's output, so it
  is neither reported nor followed; a repository may keep its own commands and its own skill
  directories. The exceptions are an extra file inside a recorded or planned skill directory
  (`W107`) and a missing lockfile, which refuses rather than guessing (see *A missing lockfile*). A
  symlink at a *managed* path is still drift, and a symlinked ancestor is still refused.
- **The hooks plugin is verified by structure, with one provenance gap.** Containment compares the
  commands, events and matchers the plugin registers. rulesync escapes a hook command for a template
  literal (backslashes doubled, backticks and `${` prefixed with a backslash); the gate undoes that
  escaping in the inverse order before comparing, because it is the renderer's representation of the
  same command. Each command's matcher is read from the slice between the previous command and this
  one, so a matcher-less hook cannot inherit a neighbour's guard and a dropped matcher cannot be
  replaced by an earlier identical one. The parser matches rulesync 43.12.0's two registration shapes
  and cannot recognise a registration emitted as a template literal under a future renderer, so a
  plugin that keeps the same commands but changes its registration shape is caught only by `check`
  against a fresh render of the pinned renderer. A change to rulesync's generated helper code that
  keeps the same registrations is likewise caught only by `check`, not by a committed plugin
  golden.
- **Skill extra files must be UTF-8.** The managed-output pipeline compares and writes text, so a
  binary asset inside a skill directory is refused (F001) rather than carried; decoding and
  re-encoding a valid UTF-8 file is byte-identical.

## Behaviour notes

These are the deliberate choices a reader of the harness documentation may not expect. Each is
rendered by the pinned renderer and verified before a byte is written.

- **Personas are YAML; config and permission resources are JSONC.** Config and permission files
  reject duplicate keys. Persona files are `.farna/personas/*.yaml`.
- **A permission resource may declare `patterns`.** A resource can carry
  `patterns: { "<category>": { "<pattern>": "allow" | "ask" | "deny" } }` in addition to its bare
  category values, which emits the harness's `Bash(P)` / `Edit(P)` byte form. A numeric pattern key
  is refused because JavaScript would reorder it.
- **A permission resource's identity is its declared `id`, not its file name.** Two permission
  files may declare the same id: identical content is deduplicated, different content is
  `F005_CONFLICT` naming both paths. A rule's identity is its file name.
- **A model conflict is detected on the resolved concrete model id.** Two model classes that map to
  the same id do not conflict; two classes that resolve to different ids do.
- **The OpenCode per-agent `task` category is authored as `task`.** The V2 raise path translates
  `task` to `subagent`; authoring `agent` would emit a record OpenCode does not read.
- **An unrepresentable OpenCode hook is a reported loss, not an omission.** `session-end`, or a
  matcher on a non-tool event, is reported as `W101_CAPABILITY_DROPPED` and is not emitted.
- **`"allowlist": true` is refused on OpenCode.** OpenCode's records are a deny-list and cannot
  name every unmodelled tool, so the Claude Code allow-list opt-in has no faithful representation.
- **Profile mode is OpenCode-only in this release.** `claudecode` refuses `active` rather than
  accepting a setting that does nothing.
- **The lockfile field is `activePersona`.** `mode` is `agent` or `profile`; `notLive` records the
  resolved-but-not-live personas. Both the mode and the selection are optional on read, so a
  lockfile written before profile mode existed still parses and is normalised to agent mode.
- **`opencode.jsonc` is structured, not whole-file.** It owns the `mcp` key only and edits it in
  place, preserving the user's own keys and comments.
- **Orphan removal is limited to recorded regular files in managed locations.** A symlink, a
  directory, an edited file or an unrecorded user file is never removed.

## Develop

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
node dist/cli/main.js check      # the committed agent config matches .farna/
npm audit --audit-level=moderate
node scripts/assert-pack.mjs     # the tarball is dist/ plus the legal files, with no source map
npm pack --dry-run               # the exact package npm would publish
npm publish --dry-run            # the publish path, without publishing
```

`npm run build` compiles `src/` to `dist/`. After a build, run the CLI with
`node dist/cli/main.js`, or link it with `npm link` to get the `farna-bootstrapper` binary.

The golden tests in `tests/golden/`, the real-renderer tests in `tests/integration/` and the
example tests in `tests/integration/examples.test.ts` drive the real, pinned renderer. They always
run: a missing or broken `rulesync` fails collection loudly rather than skipping. CI compares the
test files on disk with the committed `scripts/expected-test-files.json` manifest, requires every
manifest file to have run, and fails on either difference — so a deleted suite cannot hide behind
the total, and a new suite is a deliberate, visible manifest edit. It also enforces a minimum total
test count (not an exact one), that no test is pending or `todo`, that `numPassedTests` accounts for
the whole run, and that the real-renderer suites ran. CI also type-checks `tests/`, audits
dependencies at `moderate`, and proves that `npm pack` from a tree with `dist/` moved aside still
contains the entry points, which can only happen if `prepack` builds them, and that every path in
the tarball is on the allowlist with no source map.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full gate list and the pull-request expectations.
Maintainers publish a release by pushing a `v*` tag; `.github/workflows/release.yml` verifies the
tag is on `main`, runs the gates, publishes the packed tarball to npm with provenance, and creates
the GitHub Release. The publish job waits for approval on the `release` environment, whose
`NPM_TOKEN` secret carries the npm token. See [Releasing](CONTRIBUTING.md#releasing).

## This repository dogfoods itself

The source of this repository's own agent configuration is `.farna/`: one persona, `maintainer`,
built from a rule distilled from [CONTRIBUTING.md](CONTRIBUTING.md) and a permission resource.
`generate` renders it to a committed `.claude/agents/maintainer.md` and records the manifest in
`.farna/lock.json`.

```sh
node dist/cli/main.js generate   # after any change under .farna/
node dist/cli/main.js check      # re-render and compare; drift exits 1
```

`check` runs in CI, so a change to `.farna/` that was not regenerated, or a hand-edited generated
file, fails the build rather than merging quietly.

This is the `claudecode` target in agent mode, and nothing else. This release renders exactly one
configured target per run and Claude Code has no profile mode, so the OpenCode half of the dogfood
waits on multi-target rendering; it is not represented here today.

## Licence

MIT, Copyright (c) 2026 Farnalabs Ltd. See `LICENSE` and `NOTICE`. Security reports are handled
under [SECURITY.md](SECURITY.md). This project depends on
[rulesync](https://github.com/dyoshikawa/rulesync) (MIT, Copyright (c) 2024 dyoshikawa), used
unmodified as a library; the third-party licence text is reproduced in `NOTICE`.
