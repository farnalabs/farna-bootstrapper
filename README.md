# farna-bootstrapper

Compile named agent personas and their resources into the configuration a coding harness
actually reads, and prove that the committed output still matches the source.

This repository is at **M2a: persona composition and permission validation**, on Claude Code
only. It implements one target (`claudecode`), three commands of the compiler loop (`generate`,
`check`) plus `init`, two resource kinds (`rule`, `permission`) plus a model class, and
one base persona per composed persona (`extends`). Everything else is deliberately deferred; see
[What this slice does not do](#what-this-slice-does-not-do).

## The loop

1. You declare personas, their rules and their permissions under `.farna/`.
2. `farna-bootstrapper generate` renders the Claude Code agent files into `.claude/agents/` and
   records what it wrote in `.farna/lock.json`.
3. `farna-bootstrapper check` renders the same input into a temporary directory and compares it
   with the repository. Exit `0` when identical, `1` when anything drifted.

`generate` never writes until every gate has passed. Each persona's body must contain its own
rule text, and must not contain another persona's exclusive rule text. A renderer that drops
content or mixes personas is refused before the first byte reaches the repository. Every
permission category is validated before anything is materialised: a category the target cannot
carry refuses the run (F011) rather than being emitted as an inert string.

## Requirements

- Node.js **22.22.0 or newer**
- npm

## Develop

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run build` compiles `src/` to `dist/`. After a build, run the CLI with
`node dist/cli/main.js`, or link it with `npm link` to get the `farna-bootstrapper` binary.

The golden test in `tests/golden/` and the integration test in `tests/integration/` drive the
real, pinned renderer. They run when the `rulesync` dependency is installed, which `npm ci`
guarantees, and are skipped otherwise.

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
    rules/
    permissions/
.gitignore        # with .farna/local.jsonc and .farna/.journal.json
```

Add one YAML file per persona under `.farna/personas/`, one Markdown file per rule under
`.farna/resources/rules/`, and one JSONC file per permission under
`.farna/resources/permissions/`:

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

`generate` and `check` accept `--json` for one machine-readable object on stdout.

A persona's rule text is joined into the body of its Claude Code subagent, in canonical rule-id
order, under a `## displayName` heading. The rule body itself is never re-wrapped or re-indented.

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

A composed persona is one new name. There are no multi-parent unions and no per-target branches
in the source.

## Permissions

The canonical categories are `read`, `write`, `edit`, `shell`, `network`, `mcp`, `task` and `*`.
They are validated at plan time and mapped to the target's own form before anything is written:

| Category | Claude Code entry | Note |
|---|---|---|
| `read` | `Read` / `Read(P)` | native |
| `write` | `Write` / `Write(P)` | native; `Write` is its own tool, distinct from `Edit` |
| `edit` | `Edit` / `Edit(P)` | native |
| `shell` | `Bash` / `Bash(P)` | native |
| `task` | `Agent` / `Agent(P)` | native; `Task` is a legacy alias in Claude Code, `Agent` is the emitted name |
| `network` | none | refused (F011, exit 3): the target has no mapping |
| `mcp` (bare) | none | refused (F011, exit 3): a bare category restricts nothing |
| `*` | expands to every category | refused (F011), because it covers `network` |

`ask` has no per-agent surface on Claude Code, so it is emitted as `deny` and reported (W111).
Every other category is native and maps 1:1 onto a distinct tool, so there is no W112 on this
target; the design's lossy `write` -> `edit` collapse belongs to OpenCode (M2b). When two
permission resources disagree on a category, the stricter value wins and the disagreement is
reported (W106). Both arrays are sorted alphabetically and every entry starts with the harness's
capitalised tool name.

Only the harness's own tool names reach the renderer source tree. A product category name is
never written there; a test asserts it.

Warnings are printed by `generate` and `check`, and recorded in `.farna/lock.json`.

## Layout

```text
src/
  cli/            Commander wiring, the three commands, and the error boundary
  config/         strict JSONC config schema and loader
  source/         YAML personas, markdown rules, JSONC permissions, strict frontmatter
  compose/        extends resolution, resource union, deny-wins merge, digests
  permissions/    the canonical vocabulary and the Claude Code mapping
  materialise/    persona -> rulesync source tree
  render/         port.ts (the seam), upstream.ts (the only rulesync import), stage, commit
  verify/         containment and cross-persona isolation gates
  lock/           lockfile construction
  report/         text and JSON output, warning records
tests/
  fixtures/demo/      the M1 fixture: two personas, two rules, no permissions
  fixtures/composed/  builder, builder-python (extends builder) and reviewer, with permissions
  golden/             the composed persona's pinned emitted bytes
  unit/               composition, permissions, fake-renderer gates, loader, init, check
  integration/        the real pinned renderer
```

`.farna/lock.json` records the renderer identity, each persona's composition base, its resolved
resource ids (each with the persona that contributed it), a persona digest, a permission digest,
and the path, size and SHA-256 of every managed file. It contains no timestamps, hostnames or
absolute paths.

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

- `doctor`; profile mode; the OpenCode target and every other target; `agent with loss` and
  `refuse` as plan outcomes; the full 71-target capability matrix and the capability report page
- the `mcp`, `skill`, `command` and `hook` resource kinds; model resources (a model is the
  persona's `model` class in this slice)
- `patch` and `replaceWith` on a persona resource reference; `targets` filters on personas and
  resources; `--strict`; `--accept-config` gating; `.farna/local.jsonc`
- deletion or sweeping of orphaned managed files: `check` reports an unexpected path and
  `generate` never deletes a file it did not write in the current run
- structured or region ownership; only whole files are owned
- the weekly renderer-sync bot and the two compiled binaries

## Deviations from `design/`

The M1 slice was intentionally narrower than the design documents, and M2a narrows or extends
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
6. **Only `rule`, `permission` and a model class are resolvable.** A persona may reference
   `rule/<id>` and `permission/<id>`, and name a `model` class. Any other resource kind is
   rejected with a clear error rather than accepted and ignored. `targets.<t>.active` and
   `exclude` are also rejected: profile mode and per-target filters are later work, and accepting
   them here would be a silent no-op. For the same reason `ignoredFiles` is not accepted yet: an
   unknown-key error is louder than a setting that quietly does nothing.
7. **`check` exits `1` on any drift.** `schema.md` §7 assigns `F007` exit `4`. The brief for the
   M1 slice requires `0` clean / `1` drift, so `check` returns `1` and reports the `F007` code in
   its payload. `generate` keeps the design's per-code exits (`F008` is `4`, `F011` is `3`).
8. **No matrix snapshot or matrix digest.** The one-target, seven-cell snapshot, `probe`, and the
    `matrixDigest` lockfile field are later work. The lockfile records the renderer identity,
    personas, resources, digests, managed files and warnings only.
9. **The lockfile records warnings and two digests per persona.** `schema.md` 5.1 has a
    `warnings[]` array; it is carried here together with a `permissionDigest`. The resolved
    resource `rank` is not recorded; `fromPersona` is.
10. **The permission digest covers the resolved product map** (category values and patterns), not
    the emitted Claude Code entries. The target mapping is code, not source; the digest changes
    when the source changes.
11. **Only W106 and W111 are emitted in this milestone.** W112 is defined in the design's code
    table but is not emitted on Claude Code: `write` is native there, and the lossy mapping is
    OpenCode's (M2b). The remaining W table, `--strict`, and severity promotion are deferred.
12. **One recursive delete exists, in `src/render/stage.ts`.** It removes only the `mkdtemp`
    directory the stage created, after proving it is inside the canonical temporary root. The
    design's "no recursive delete in `src/`" rule is about never deleting user content; a
    self-created temp stage is the one justified exception, and stage cleanup is required.

## Licence

MIT, copyright Farnalabs Ltd. See `LICENSE` and `NOTICE`. This project depends on
[rulesync](https://github.com/dyoshikawa/rulesync) (MIT, dyoshikawa and contributors), used
unmodified as a library.
