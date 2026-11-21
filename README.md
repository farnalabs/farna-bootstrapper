# farna-bootstrapper

Compile named agent personas and their resources into the configuration a coding harness
actually reads, and prove that the committed output still matches the source.

This repository is at **M2b: the OpenCode target and the workspace resource kinds**. It implements
two targets (`claudecode` and `opencode`), three commands of the compiler loop (`generate`,
`check`) plus `init`, six resource kinds (`rule`, `permission`, `mcp`, `skill`, `command`, `hook`)
plus a model class, and one base persona per composed persona (`extends`). Exactly one configured
target is rendered per run. Everything else is deliberately deferred; see
[What this slice does not do](#what-this-slice-does-not-do).

## The loop

1. You declare personas and their resources under `.farna/`, and select one target in the config.
2. `farna-bootstrapper generate` renders that target's artefacts and records what it wrote in
   `.farna/lock.json`. Claude Code gets one whole file per persona under `.claude/agents/`; OpenCode
   gets one whole file per persona under `.opencode/agents/` plus the workspace files its resource
   kinds need.
3. `farna-bootstrapper check` renders the same input into a temporary directory and compares it
   with the repository. Exit `0` when identical, `1` when anything drifted.

`generate` never writes until every gate has passed. Containment means equality, not substring
presence: each persona's artefact must be a non-empty markdown file whose emitted frontmatter has
exactly the keys the persona declares (`name` and `description`, plus `model`, `disallowedTools`
and, only when a permission resource opts in, `tools`) with matching values, and whose body is
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

## Install

`npm install farna-bootstrapper` (registry), `npm install <git-url>` and `npm install -g
farna-bootstrapper` all work. `prepare` builds `dist/` for a git install and `prepack` builds it
for the published tarball; a source checkout therefore produces a working `bin` without a manual
build. The renderer's integrity is read from exactly two npm lock records at the **install root**,
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

## Develop

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm audit --audit-level=moderate
node scripts/assert-pack.mjs     # after a build: the tarball contains dist
```

`npm run build` compiles `src/` to `dist/`. After a build, run the CLI with
`node dist/cli/main.js`, or link it with `npm link` to get the `farna-bootstrapper` binary.

The golden test in `tests/golden/` and the integration test in `tests/integration/` drive the
real, pinned renderer. They always run: a missing or broken `rulesync` fails collection loudly
rather than skipping. CI compares the test files on disk with the committed
`scripts/expected-test-files.json` manifest, requires every manifest file to have run, and fails
on either difference — so a deleted suite cannot hide behind the total, and a new suite is a
deliberate, visible manifest edit. It also enforces a minimum total test count (not an exact one),
that no test is pending or `todo`, that `numPassedTests` accounts for the whole run, and that both
real-renderer suites ran. CI also type-checks `tests/`, audits dependencies at `moderate`, and proves that
`npm pack` from a tree with `dist/` moved aside still contains the entry points, which can only
happen if `prepack` builds them.

## Use

```sh
mkdir my-agents && cd my-agents
farna-bootstrapper init
```

`init` creates (it accepts `--json` like `generate` and `check`, emitting one object on stdout):

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
.gitignore        # .farna/local.jsonc, the journal, the staging namespace and OS metadata
.gitattributes    # every generated path, for both targets, pinned to LF
```

The `--json` object is `schemaVersion`, `command` (`init`), `ok`, `exitCode`, `root`,
`configPath`, `created` and `updated` (the array of existing shared files this run appended to),
and `nextStep`. It reports the shared files as `created` or `updated`; it never claims a file it
did not touch. `init` preserves the existing bytes and mode of `.gitignore` and `.gitattributes`,
appends only the missing lines, and restores both byte for byte if a later step fails.

Add one YAML file per persona under `.farna/personas/`, one Markdown file per rule under
`.farna/resources/rules/`, and one JSONC file per permission under
`.farna/resources/permissions/`. The workspace resource kinds live in their own directories:
`mcp/<id>.jsonc`, `skills/<id>/SKILL.md` (plus any extra files), `commands/<id>.md` and
`hooks/<id>.jsonc`:

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
farna-bootstrapper generate          # write the agent files and the lockfile
farna-bootstrapper generate --dry-run # print the plan, write nothing
farna-bootstrapper check             # prove the tree matches a fresh render
```

Every command accepts `--json`. A success object carries `schemaVersion`, `command`, `ok`,
`exitCode` and the command's own fields; `init` adds `root`, `configPath`, `created`, `updated` and
`nextStep`.

Every command emits one machine-readable object on stdout under `--json`, and every object carries
`schemaVersion`, `command`, `ok` and `exitCode`; a typed failure also carries `code`,
`subject` and `message`, and is emitted on stdout with the human line on stderr. `--dry-run`
compares each managed path with the working tree, so `unchanged` and `would-write` are
distinguished rather than every path being reported as a write. Its summary counts the
`would-write` files, not the size of the plan: a tree that already matches reports
`would write 0 file(s), N unchanged`.

A persona's rule text is joined into the body of its subagent, in canonical rule-id order, under a
`## displayName` heading. The rule body itself is never re-wrapped or re-indented. There is no
shared root rules file: the per-agent body is the only rule surface, so one persona's rules never
reach another persona's artefact.

## Targets

Exactly one target is configured per run. Switching target is one config edit:

```jsonc
// .farna/config.jsonc — the OpenCode target
{
  "schemaVersion": 1,
  "targets": { "opencode": {} },
  "models": {
    "standard": { "opencode": "anthropic/claude-sonnet-4-5" }
  }
}
```

Both targets are rendered by the pinned rulesync renderer; the product derives the feature set from
the materialised source instead of passing `*`, and verifies the bytes the renderer produced before
writing any of them.

### Output layout

```text
claudecode, agent mode:
  .claude/agents/<id>.md            one whole file per persona

opencode, agent mode:
  .opencode/agents/<id>.md          one whole file per persona
  opencode.jsonc                    the workspace MCP servers, when any persona declares mcp
  .opencode/skills/<id>/SKILL.md    one tree per skill, with every extra file
  .opencode/commands/<id>.md        one whole file per command
  .opencode/plugins/rulesync-hooks.js   the generated plugin, when a representable hook exists

both:
  .farna/lock.json                  the manifest and the source-derived warnings
```

Every path is conditional on a declaration. A tree that declares no MCP server writes no
`opencode.jsonc`; a tree that declares no representable hook writes no plugin. `check` computes the
expected set independently of what the renderer reports, so a dropped or invented workspace file is
refused rather than written.

### OpenCode workspace resources

OpenCode carries MCP servers, skills, commands and hooks at the **workspace** level, not per agent.
The product therefore emits each declaration once, from the union of the live personas, and reports
the scoping loss rather than pretending the resource belongs to one persona:

| Resource | Emitted as | Warning |
|---|---|---|
| `mcp/<id>` | `opencode.jsonc` `mcp.servers.<id>` | `W101_CAPABILITY_DROPPED`, HIGH |
| `skill/<id>` | `.opencode/skills/<id>/**` | `W101_CAPABILITY_DROPPED`, MEDIUM |
| `command/<id>` | `.opencode/commands/<id>.md` | `W101_CAPABILITY_DROPPED`, MEDIUM |
| `hook/<id>` | `.opencode/plugins/rulesync-hooks.js` | `W101_CAPABILITY_DROPPED`, HIGH |

Each warning names the resource and the persona that declared it, for example:

```text
W101_CAPABILITY_DROPPED high   builder: mcp/scan is applied to the whole OpenCode workspace, not to
  persona builder alone: OpenCode configures MCP servers at the workspace level, not per agent
```

A hook OpenCode cannot express is **dropped**, never emitted as something that looks like a hook:

| Hook phase | OpenCode |
|---|---|
| `before-tool` | carried as `preToolUse` |
| `after-tool` | carried as `postToolUse` |
| `session-start` | carried as `sessionStart` |
| `stop` | carried as `stop` |
| `session-end` | not representable, dropped with W101 |
| any phase with a `matcher` other than `before-tool` / `after-tool` | matcher cannot be honoured, dropped with W101 |

The hook plugin is generated JavaScript, so containment checks the executable surface: the exact
multiset of declared commands, each bound to its declared event and matcher, with no undeclared
command allowed. `check` still compares the plugin byte for byte against a fresh render, because a
whole file is owned; the golden test pins the agent file and the workspace config.

MCP environment values are references only. A resource declares
`{ "fromEnv": "EXAMPLE_TOKEN" }`; the materialiser writes rulesync's canonical `${EXAMPLE_TOKEN}`,
and the OpenCode adapter emits `{env:EXAMPLE_TOKEN}`. A literal value in a credential position is
`F002_SECRET_LITERAL` and is never echoed. Neither target ever reads the value.

The workspace resource kinds are **not** carried by `claudecode` in this slice. A persona that
references one is refused (F001) rather than silently losing it, because Claude Code's per-agent
surface for those capabilities is later work.

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

| Category | Claude Code entry | OpenCode record | Note |
|---|---|---|---|
| `read` | `Read` / `Read(P)` | `{action: read}` | native on both |
| `write` | `Write` / `Write(P)` | `{action: edit}` | native on Claude Code; on OpenCode it folds into `edit` (W112) |
| `edit` | `Edit` / `Edit(P)` | `{action: edit}` | native on both |
| `shell` | `Bash` / `Bash(P)` | `{action: shell}` | native on both |
| `task` | `Agent` / `Agent(P)` | `{action: subagent}` | native on both |
| `network` | none | none | refused (F011, exit 3): neither target has a mapping |
| `mcp` (bare) | none | none | refused (F011, exit 3): a bare category restricts nothing |
| `*` | expands to every category | same | refused (F011), because it covers `network` |

On OpenCode the records are an ordered array of `{ action, resource, effect }`. `bash` is emitted
as `shell` and `task` as `subagent`, and the array preserves the materialiser's order so a later
record is the effective one. `write` has no OpenCode category: it is folded into `edit`, and
when a `write` declaration is the only source of an `allow`, the widening is reported as
`W112_PERMISSION_LOSSY` (HIGH). A `write` that resolves `deny` is not reported: it narrows, and a
stricter rule must never be presented as a loss. `ask` is emitted as `deny` on both targets and
reported as `W111_ASK_DOWNGRADED`, because neither has a measured ask surface.

### Allow-list vs deny-list

Claude Code's per-agent `tools` field is an **allow-list**: naming three tools removes every tool
it does not name, including `Glob`, `Grep`, `WebFetch`, `TodoWrite`, `NotebookEdit` and any tool
this product does not model. The default is therefore a **deny-list**: `allow` entries emit
nothing (the tool is available unless denied), while `deny` and an `ask` downgraded to `deny` are
emitted into `disallowedTools`. A partial allow set can never silently narrow a persona.

A permission resource may opt in with `"allowlist": true`. The resolved persona then emits the
ordered `tools` allow-list and a `W113_ALLOW_LIST_NARROWS` warning names every unmodelled tool the
narrowing removes. The mode is persona-scoped: if any contributing resource opts in, the union of
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

An OpenCode persona may not opt into the Claude Code `tools` allow-list. OpenCode's records are a
deny-list and cannot name every unmodelled tool, so `"allowlist": true` is refused (F001) on that
target rather than silently ignored.

Only harness-specific category names reach the renderer source tree; a product category name is
never written there, and a test asserts it.

Warnings are printed by `generate` and `check`, and recorded in `.farna/lock.json`.

## Layout

```text
src/
  cli/            Commander wiring, the three commands, and the error boundary
  config/         strict JSONC config schema and loader
  source/         YAML personas; markdown rules, skills and commands; JSONC permissions,
                  MCP servers and hooks; strict frontmatter and reference-only secrets
  compose/        extends resolution, resource union, deny-wins merge, digests, W101
  permissions/    the canonical vocabulary and the Claude Code and OpenCode mappings
  materialise/    persona and workspace resources -> rulesync source tree
  render/         port.ts (the seam), upstream.ts (the only rulesync import),
                  identity.ts (installed vs pinned renderer), prepare.ts (the pipeline),
                  stage.ts (the disposable stage), commit.ts (the write), staging.ts
  verify/         containment and cross-persona isolation gates
  lock/           lockfile construction and validated reading
  core/           constants, typed errors, paths, strict UTF-8 reads, canonical JSON
  report/         text and JSON output, warning records
tests/
  fixtures/demo/      the M1 fixture: two personas, two rules, no permissions
  fixtures/composed/  builder, builder-python (extends builder) and reviewer, with permissions
  fixtures/opencode/  the OpenCode fixture: rules, permissions, MCP, a skill, a command, a hook
  golden/             both targets' pinned emitted bytes and the OpenCode workspace config
  unit/               composition, permissions, fake and mutating renderer gates, loader, init,
                      check, paths
  integration/        the real pinned renderer
  cli/                the built CLI: exit codes, JSON envelopes and drift output
scripts/              CI gates: the minimum test count, real-renderer suites and tarball contents
```

`.farna/lock.json` records `schemaVersion`, `product` (name and version), `target` (`claudecode` or
`opencode`), `mode` (`agent`), the `renderer` identity, each persona's composition base and resolved
resource ids (each with the persona that contributed it, across every loaded kind), a persona
digest, a permission digest, every source-derived warning (including the OpenCode workspace-level
`W101` records), and the path, size and SHA-256 of every managed file. It does **not** list
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

## The renderer boundary

`src/render/port.ts` defines `RenderTarget`. `src/render/upstream.ts` is the only module that
imports `rulesync`, and `src/cli/main.ts` is the only place that binds the real implementation.
Unit tests use an independent fake renderer, so the failure modes the port exists to catch can be
exercised without the network or the real renderer.

`rulesync` is pinned to exactly `43.11.0` with a tarball integrity. The lockfile records that pin,
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

## What this slice does not do

Deliberately out of scope, by milestone:

- `doctor`; profile mode; `agent with loss` and `refuse` as plan outcomes; rendering more than one
  configured target per run; every target other than `claudecode` and `opencode`; the full
  71-target capability matrix and the capability report page
- model resources (a model is the persona's `model` class in this slice)
- carrying `mcp`, `skill`, `command` or `hook` on `claudecode`
- `patch` and `replaceWith` on a persona resource reference; `targets` filters on personas and
  resources; `--strict`; `--accept-config` gating; `.farna/local.jsonc`
- deletion or sweeping of orphaned managed files: `check` reports an unexpected path inside a
  managed directory (`.claude/agents/`, `.opencode/agents/`, `.opencode/commands/`,
  `.opencode/skills/` and `.opencode/plugins/`) and `generate` never deletes a file it did not write
  in the current run. Switching target therefore leaves the previous target's artefacts in place,
  unrecorded and unreported.
- structured or region ownership; only whole files (and, for a skill, a whole tree) are owned
- the weekly renderer-sync bot and the two compiled binaries

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
  rather than a follow or a hang. A malformed document is reported as drift, never consumed
  partially.
- **Staging leftovers.** A killed `generate` can leave `.<target>.farna-tmp-*` siblings. They are
  ignored by `check` and swept at the start of the next `generate`; a leftover that cannot be
  removed is best-effort and never a managed path.
- **No coverage gate.** There is no coverage provider or threshold in this slice. CI runs lint,
  type-check, tests (with a minimum count and real-renderer suite assertions), a dependency audit at
  `moderate`, and a published-tarball check.
- **Windows-specific test skips.** The symlink regression tests are skipped on Windows because
  creating a symlink needs a privilege the runner does not grant. CI runs them on Linux; the guard
  code itself is platform-independent.
- **Stray files outside the managed directories** are not reported by `check`; the unexpected-path
  scan is scoped to `.claude/agents/` and OpenCode's `agents/`, `commands/`, `skills/` and
  `plugins/` trees. The only names ignored inside them are this tool's own staging namespace and OS
  metadata.
- **The hooks plugin is verified by structure, not by a committed golden.** Containment asserts the
  exact commands, events and matchers; a change to rulesync's generated helper code that keeps the
  same commands and events is caught only by `check` against a fresh render of the pinned renderer,
  not by a committed plugin golden.
- **Skill extra files must be UTF-8.** The managed-output pipeline compares and writes text, so a
  binary asset inside a skill directory is refused (F001) rather than carried; decoding and
  re-encoding a valid UTF-8 file is byte-identical.

## Deviations from `design/`

The M1 slice was intentionally narrower than the design documents; M2a and M2b narrow or extend
them further. The differences, all deliberate:

1. **npm and Node, not Bun.** The design pins `bun` as the package manager and test runner. Bun is
   not installed on the delivery host, so this slice uses npm, `tsc` and Vitest. The package
   exposes the same ESM build and `bin`, and `engines.node` is unchanged at `>=22.22.0`.
2. **Personas are YAML, not JSONC.** The brief for M1 specified `.farna/personas/*.yaml`. The
   design's JSONC persona format, with its parse-tree duplicate-key rules, remains a later target.
   Config and permission resources are JSONC with duplicate keys rejected.
3. **Permission resources may declare `patterns`.** `schema.md` 4.5 has no pattern field on a
   permission resource. The brief requires the `Bash(P)` / `Edit(P)` byte form, so a resource may
   add `patterns: { "<category>": { "<pattern>": "allow" | "ask" | "deny" } }`. Patterns are
   emitted into the per-agent lists, which is the only array this slice writes. The design notes
   that a per-agent *pattern* map is not a measured Claude Code surface; the workspace
   `.claude/settings.json` is not written in agent mode, because a shared permission block would
   leak one persona's deny onto every other persona.
4. **A permission resource's identity is its declared `id`, not its file name.** This is the
   design's rule (`schema.md` 1.2) and is what makes the duplicate-content conflict reachable: two
   permission files may declare the same id, which is F005 (naming both paths) when their content
   differs and a deduplication when it does not. Rules keep M1's file-name rule.
5. **A model conflict is detected on the resolved concrete model id.** Two classes that map to the
   same model id do not conflict; two classes that resolve to different ids do (F005).
6. **A persona may reference `rule`, `permission`, `mcp`, `skill`, `command` and `hook`, and name
   a `model` class.** The workspace kinds are loaded for every target but carried only by
   `opencode`; a `claudecode` tree that references one is refused (F001) rather than silently
   losing it. A `model/<id>` reference is still refused: a model is the persona's `model` class.
   `targets.<t>.active` and `exclude` are also rejected: profile mode and per-target filters are
   later work, and accepting them here would be a silent no-op. For the same reason `ignoredFiles`
   is not accepted yet: an unknown-key error is louder than a setting that quietly does nothing.
7. **`check` exits `1` on any drift, and `F007` is not an exception code.** The brief requires `0`
   clean / `1` drift, so `check` returns `1` and reports `F007_DRIFT` in its payload. The design's
   exit table assigned `F007` exit `4`; carrying that entry while returning `1` was two answers for
   one code, so `F007` is removed from the exception table and `EXIT.drift` is `1`. `generate`
   keeps the design's per-code exits (`F008` is `4`, `F011` is `3`).
8. **No matrix snapshot or matrix digest.** The one-target, seven-cell snapshot, `probe`, and the
    `matrixDigest` lockfile field are later work. The lockfile records the renderer identity,
    personas, resources, digests, managed files and source warnings only.
9. **The lockfile records source warnings and two digests per persona.** `schema.md` 5.1 has a
    `warnings[]` array; it is carried here together with a `permissionDigest`. The resolved
    resource `rank` is not recorded; `fromPersona` is. The array holds warnings derived from the
    source, never a renderer-level one such as `W114`: that is evidence about the machine, and
    recording it made two machines with the same source produce different lockfile bytes.
10. **The permission digest covers the resolved product map** (category values and patterns), not
    the emitted Claude Code entries. The target mapping is code, not source; the digest changes
    when the source changes.
11. **W101, W106, W111, W112, W113 and W114 are emitted in this milestone.** The full codes are
    `W101_CAPABILITY_DROPPED` (workspace-level OpenCode resources), `W106_DENY_WINS`,
    `W111_ASK_DOWNGRADED`, `W112_PERMISSION_LOSSY` (OpenCode's `write` fold only; `write` is
    native on Claude Code), `W113_ALLOW_LIST_NARROWS` and
    `W114_RENDERER_INTEGRITY_UNVERIFIED`. W101's severity is dynamic: HIGH for a boundary
    capability (`mcp`, `hook`) and MEDIUM for content (`skill`, `command`); every record names the
    resource and the persona. W113 is
    emitted whenever a resource opts into the `tools` allow-list: it names the tools the narrowing
    removes, and an opt-in whose categories all resolve deny/ask is reported as having no effect
    (no `tools` is emitted, and the digest records the same effective value the artefact does).
    W114 is emitted when the installed renderer's tarball integrity could not be located and
    verified in the hidden (`<installRoot>/node_modules/.package-lock.json`) or install-root
    (`<installRoot>/package-lock.json`) npm lock record; its medium severity reflects
    that the version check still runs, so this is a provenance gap rather than a correctness
    failure, but it is never a silent pass. It is reported by `generate` and `check` and is not
    written into the lockfile. The remaining
    W table, `--strict`, and severity promotion are deferred.
12. **One recursive delete exists, in `src/render/stage.ts`.** It removes only the `mkdtemp`
    directory the stage created, after proving it is inside the canonical temporary root. The
    design's "no recursive delete in `src/`" rule is about never deleting user content; a
    self-created temp stage is the one justified exception, and stage cleanup is required.
13. **`F012_WRITE_FAILED` (exit `5`) is added for a commit that cannot complete.** It names the
    managed path. A failure before the first rename leaves the tree unchanged; a failure between
    renames restores what it can and reports any file it could not restore. The design's code table
    has no write-failure code; this is a new one rather than overloading `F009` (a renderer
    failure) with a filesystem error.
14. **A rule's `description` frontmatter key is rejected.** Nothing emitted it, and a field the tool
    accepts and ignores is the silent no-op the strict schema exists to prevent. Persona
    `displayName` remains a required human label but is no longer required to be unique: it is not
    emitted either, so a uniqueness rejection would have been a false rejection of valid input.
15. **A YAML file with more than one document is refused (F001).** Parsing only the first document
    would silently discard every persona after the first `---`.
16. **`generate` and `init` are atomic for a caught failure.** The managed output is staged in
    sibling temporary files and renamed only after every write has succeeded, and a rename failure
    restores what it already replaced (reporting any restore it could not complete). Created
    directories are recorded one level at a time and removed on failure; a directory the rollback
    could not remove is named in the error instead of the error claiming a clean tree. A crash
    between renames is not atomic; `init` preflights the one path that can fail on an ordinary
    filesystem state, writes it with `O_EXCL` under an unpredictable name, and rolls back what it
    created.
17. **Exactly one target is rendered per run.** `targets` admits one entry; a second is F001.
    Rendering both in one run needs a per-target lockfile and mode plan, which is later work. The
    committed lockfile records the target that produced it, and `check` compares the bytes.
18. **OpenCode's workspace resources are emitted from the union of the live personas.** MCP,
    skills, commands and hooks are workspace-level on OpenCode, so the materialiser writes each
    declaration once and every persona receives a W101 record naming it. This is the honest
    representation of the measured matrix, not a per-persona capability.
19. **The OpenCode per-agent `task` category is authored as `task`, not `agent`.** The design's
    canonical mapping authors `task` as rulesync's `agent`. Measured at rulesync 43.11.0, the
    per-agent V2 raise path translates `task` to `subagent` but passes `agent` through
    untranslated, where OpenCode does not read it. Authoring `agent` would emit an inert record,
    so the materialiser authors `task` and a test pins the emitted `subagent` action.
20. **An OpenCode hook it cannot represent is dropped, with W101.** `session-end` has no OpenCode
    event, and a `matcher` is honoured only on the tool events (`before-tool`, `after-tool`). Those
    hooks are not emitted and the loss is HIGH because a hook is a boundary capability.
21. **A skill's extra files are UTF-8 text.** The managed-output pipeline compares and writes text,
    so a valid UTF-8 file is reproduced byte for byte and a non-UTF-8 asset is refused (F001)
    rather than corrupted.
22. **`"allowlist": true` is refused on OpenCode.** OpenCode's permission records are a deny-list
    and cannot name every unmodelled tool, so the Claude Code allow-list opt-in has no faithful
    representation; it is F001, never a silent no-op.
23. **A per-agent command on Claude Code remains unsupported here.** The design's matrix marks
    `command` as dropped per agent on both targets; this slice carries the command kind on OpenCode
    only, and refuses it on Claude Code with the other workspace kinds.
24. **The new resource kinds accept only fields the tool carries.** `command` and `skill` accept
    `description` (emitted), not `displayName`; `mcp` and `hook` accept neither, because neither is
    written into the artefact. `schema.md`'s generic `ResourceBase` allows a display name for every
    resource; accepting one that is never emitted would be the silent no-op the strict schema exists
    to reject. A rule keeps `displayName`, because it names the rule's section in the persona body.

## Licence

MIT, copyright Farnalabs Ltd. See `LICENSE` and `NOTICE`. This project depends on
[rulesync](https://github.com/dyoshikawa/rulesync) (MIT, dyoshikawa and contributors), used
unmodified as a library.
