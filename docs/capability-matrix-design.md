# A measured capability matrix, grown one verified target at a time: design proposal

## 1. Status and scope

This was a design proposal. Slice 1 and the slice-2 groundwork are on `main`: the page is generated
with its CI staleness gate, and the permission-key cells name the test that observes them. The
target waves the proposal describes remain unimplemented. Sections 1 to 8 describe current behaviour
only where they cite the code; the rest is the record as written against the commit it was written
for. Section 9 is a plan and section 10 records that the design has no open questions.

It exists because two rules in [CONTRIBUTING.md](../CONTRIBUTING.md) make a proposal the precondition
for this change:

> **No new subcommand without a design change.** The CLI surface is `init`, `doctor`, `report`,
> `generate` and `check`.

> **At most one target per output-path family.** A change that adds a new family, or a second target
> inside an existing one, needs a design change first.

Growing the matrix means adding targets, and publishing it means adding tooling around `report`.
Both need the decision written down before any of it lands.

### The problem

`report` measures three targets. The pinned renderer accepts 71 target ids. The three rows are real:
every capability cell is backed by a test the row names, and the snapshot is checked against the
pinned renderer before it is printed. The gap is therefore not a documentation gap, it is how much
of the product has been built and verified.

There is no generated page. `report` prints a table to a terminal and one JSON object for a pipeline,
and the README restates the matrix by hand in
[Capability matrix](../README.md#capability-matrix). The README already names the missing artefact
twice, at line 497 and line 1012 at the commit this note was written against:

> The full 71-target matrix and the generated `docs/capability-matrix.md` page are not in this
> release.

Three problems follow:

1. **A reader has to run a Node CLI to learn what a target carries.** A person evaluating the tool,
   or linking a colleague to the answer, cannot read the measured record on a page.
2. **The README table is a hand-maintained copy of the measured record.** CI runs `lint`,
   `typecheck`, `assert-pack`, `build`, `check`, `test`, `assert-test-count` and `audit` (see
   [.github/workflows/ci.yml](../.github/workflows/ci.yml)); no step and no test compares the README
   tables with `report`. `tests/unit/repo-hygiene.test.ts` checks that every warning code is named
   in the README, and that is all it checks. A cell edited in one place and not the other drifts
   silently, which is the failure the tool exists to remove from generated configuration.
3. **Growth has no stated cost.** A row is not a line of data. It needs an adapter, managed
   locations, a verification reader, golden tests and a release note. Without that recorded, the
   obvious request ("add the other 68 targets") looks cheap and is not.

### What this proposal changes

- It fixes what the matrix may contain: only targets this build renders and verifies.
- It specifies a page at `docs/capability-matrix.md`, generated from the `report` output, with a CI
  gate that fails when the committed page is stale.
- It records the cost of a new verified target as a checklist, so growth can be priced and sliced.
- It records how the first wave is chosen: by evidence of demand, not by ease.
- It records the rejection of a 71-row table assembled from upstream documentation, and the one
  future form that artefact could take.

No code changes are proposed as part of this document.

### Explicitly out of scope

- **Render support for any new target.** Adding an adapter, its managed locations and its
  verification is the work described in section 6 and sliced in section 8. This document does not
  implement it and names no new target as committed.
- **Per-cell marketing claims.** The page states what this build emits and verifies. It makes no
  claim about runtime behaviour, quality or fitness of any harness.
- **Pricing, packaging and licensing.**
- **Any change to the renderer pin.** The pin stays `43.14.0` until the documented upgrade procedure
  moves it, and this design does not move it.
- **A second table for the renderer's other ids.** Section 4.2 rejects it for the `report` output and
  the page.

## 2. How it works today

Every statement in this section was read from the code at the commit this note was written against.
File and symbol names are given so a reader can check each one.

### The snapshot record

`src/matrix/snapshot.ts` holds the whole measured record. Its docstring is the rule the rest of this
design leans on:

> A cell answers two questions with one value, so it carries two emissions:
>
> - `agent`: can the capability land in the artefact for one persona, visible only to that persona?
> - `workspace`: can it land at the workspace level, visible to every persona?
>
> The value vocabulary is closed. `unknown` is not a soft `native`: it means the behaviour was never
> measured, so it is never presented as a tick.

The types, quoted exactly:

```ts
export type Emission = 'native' | 'emulated' | 'dropped' | 'unknown';

export type TargetStatus = 'promised' | 'unverified';

export type CellBasis = 'probe' | 'emitted' | 'upstream-doc' | 'none';

export type CapabilityCell = {
  agent: Emission;
  workspace: Emission;
  basis: CellBasis;
  testId: string | null;
  consequence: string | null;
};

export type PermissionKeyCell = {
  emission: Emission;
  code: string | null;
  consequence: string | null;
};

export type TargetMatrix = {
  id: SupportedTarget;
  status: TargetStatus;
  agentReach: 'primary' | 'subagent';
  cells: Record<Capability, CapabilityCell>;
  permissionKeys: Record<PermissionCategory, PermissionKeyCell>;
};

export type CapabilitySnapshot = {
  schemaVersion: 1;
  renderer: { name: string; version: string };
  targets: TargetMatrix[];
};
```

Two properties of these types matter for this design:

- `TargetMatrix.id` is `SupportedTarget`, not `string`. The row id is a compile-time member of the
  product's three-target union, so a row for an unrendered harness does not typecheck.
- `CapabilityCell.testId` is the link between a claim and the test that observes it. The docstring
  states the rule: "A cell is edited only in the same change that moves the test observing it."
  `PermissionKeyCell` has no `testId` field today. That is a gap the page would expose; section 8
  closes it in slice 1.

### The rows and the cells

`SNAPSHOT` (`src/matrix/snapshot.ts`, line 233) is the committed record:

```ts
export const SNAPSHOT: CapabilitySnapshot = {
  schemaVersion: 1,
  renderer: { name: 'rulesync', version: '43.14.0' },
  targets: [ /* claudecode, opencode, opencodev1 */ ],
};
```

The three rows are `DEFAULT_TARGET` (`'claudecode'`), `OPENCODE_TARGET` (`'opencode'`) and
`OPENCODE_V1_TARGET` (`'opencodev1'`) from `src/core/constants.ts`, and `SUPPORTED_TARGETS` is the
same three in the same order (line 122). Every row is `status: 'promised'`.

The cells are not written inline per row. They come from two builders:

- `claudeCells()` (line 179) and `CLAUDE_PERMISSION_KEYS` (line 136);
- `opencodeCells(target, testId, workspaceTestId)` (line 200) and `opencodePermissionKeys(target)`
  (line 155).

The shared test ids are constants at lines 88 to 90: `CLAUDE_TEST` is
`tests/golden/builder-python.test.ts`, `OPENCODE_TEST` is `tests/golden/opencode.test.ts` and
`OPENCODE_V1_TEST` is `tests/golden/opencode-v1.test.ts`. Workspace-backed cells point at the planner
tests that prove the workspace behaviour: `tests/unit/profile-mode.test.ts` for `opencode` and
`tests/unit/opencode-v1-target.test.ts` for `opencodev1`. Refused capabilities on `claudecode` point
at `tests/unit/loader.test.ts`. All six ids are present in `scripts/expected-test-files.json`.

The reported order of capabilities is `MATRIX_CAPABILITIES` (line 78): `rule`, `model`, `permission`,
`skill`, `command`, `mcp`, `hook`. The permission vocabulary is `PERMISSION_CATEGORIES` in
`src/permissions/permissions.ts`: `read`, `write`, `edit`, `shell`, `network`, `mcp`, `task`.

### Verification before publication

`verifySnapshot(snapshot, rendererVersion?)` (line 274) is the structural guard. It refuses, with
`F010_RENDERER_MISMATCH`:

1. a snapshot whose recorded renderer version differs from the caller's;
2. a supported target with other than exactly one row (zero or duplicates);
3. a `promised` row with an `unknown` emission on either axis for any capability.

`runReport()` in `src/cli/commands/report.ts` (line 14) calls it before building the report:

```ts
export function runReport(): CapabilityReport {
  verifySnapshot(SNAPSHOT, RENDERER_PIN.version);
  return buildCapabilityReport(SNAPSHOT);
}
```

The current behaviour was probed against the built `dist/` at this commit, not inferred:

| Mutation of a copy of `SNAPSHOT` | `verifySnapshot` result |
|---|---|
| drop the `opencodev1` row | refused, `F010_RENDERER_MISMATCH` |
| duplicate the `claudecode` row | refused, `F010_RENDERER_MISMATCH` |
| append a row with `id: 'cursor'` | **accepted** |

So `verifySnapshot` enforces coverage of the supported set and uniqueness. It does not reject a row
whose id is not a supported target, because it only counts rows per supported id. Exclusion of a
foreign row rests on the type and on one test:
`tests/unit/capability-report.test.ts` line 46 asserts
`SNAPSHOT.targets.map((target) => target.id)` equals `[...SUPPORTED_TARGETS]` exactly, and line 113
asserts the same on the report. Section 6.2 and section 8 close that with a runtime guard and a test.

### The report builder and the formatter

`src/report/capability.ts` holds both. `CapabilityReport` (line 21) is the machine shape:

```ts
export type CapabilityReport = {
  schemaVersion: 1;
  command: 'report';
  ok: true;
  exitCode: 0;
  renderer: { name: string; version: string };
  targets: Array<{
    id: string;
    status: TargetStatus;
    agentReach: 'primary' | 'subagent';
    capabilities: Record<Capability, CapabilityCell>;
    permissionKeys: Record<PermissionCategory, PermissionKeyCell>;
  }>;
};
```

`buildCapabilityReport(snapshot = SNAPSHOT)` (line 36) copies every cell into a fresh object, so a
caller cannot mutate the measured record through a report it was handed.

`formatCapabilityReport(report)` (line 166) is the human table. Its header is fixed text:

```text
farna-bootstrapper report <version>
  renderer rulesync 43.14.0
  cells    native [x]  emulated [~]  dropped [ ]  not measured [?]
  note     the committed measured matrix; the harness remains the authority on runtime behaviour
```

It then prints the capability table with two sub-columns per target (`agent`, `workspace`), a
consequence for every non-native cell, the permission-key table with its codes and consequences, a
`labels` block with each row's `status` and `reach`, and `report: ok`.

This note corrects one assumption a reader may carry: the capability formatter is not in
`src/report/format.ts`. `format.ts` holds `formatInit`, `formatGenerate`, `formatCheck`,
`formatDoctor` and `formatJson`. The capability report is entirely in `src/report/capability.ts`.

### The command surface

`src/cli/program.ts` registers `report` with one option, `--json`, and no arguments. The payload it
emits is the `CapabilityReport` object itself, not a wrapper that adds `CLI_SCHEMA_VERSION`; the
observed `node dist/cli/main.js report --json` output begins:

```json
{
  "schemaVersion": 1,
  "command": "report",
  "ok": true,
  "exitCode": 0,
  "renderer": { "name": "rulesync", "version": "43.14.0" },
  "targets": [ { "id": "claudecode", ... }, { "id": "opencode", ... }, { "id": "opencodev1", ... } ]
}
```

`report` reads no source tree and writes nothing. It is a property of the build and its pinned
renderer, which is why it is useful in an empty directory.

### The renderer boundary and the target type

`src/render/port.ts` defines the seam. `RenderTargetName` is `SupportedTarget` (line 9), and
`RenderRequest.target` is that type. `src/render/upstream.ts` is the single implementation and the
only module that imports `rulesync`; its `render` method passes `targets: [request.target]` to the
renderer. A target id is therefore the same string in both places, but the product only accepts the
three values its own union allows.

The per-target adapter is spread across four places, all of which are typed by `SupportedTarget`:

- `MANAGED_OUTPUT_DIRS` (line 195) and `MANAGED_OUTPUT_FILES` (line 204) in
  `src/core/constants.ts`, both `Readonly<Record<SupportedTarget, readonly string[]>>`, so a new
  union member fails the build until the adapter declares its locations;
- `expectedPaths(source)` and `verifyRender(...)` in `src/verify/containment.ts` (lines 940 and 975),
  which derive the exact managed path set from the plan and verify the emitted bytes against it in
  both directions;
- `renderFeatures(target, source)` in `src/materialise/source-tree.ts` (line 170), which derives the
  renderer feature set from the materialised source, never `*`;
- `findLocationCollisions` and `managedLocationsOf` in `src/config/collision.ts` (lines 33 and 55),
  which refuse two configured targets that would own one location.

`RENDERER_PIN` in `src/render/upstream.ts` (line 29) is the version and integrity the snapshot must
agree with. `CONTRIBUTING.md` states the matching rule for the seam: `src/render/upstream.ts` is the
only module allowed to import `rulesync`, including a type-only reference.

### Where the documentation already points at the page

Three committed statements already name this work:

- `README.md` line 497: the full 71-target matrix and the generated `docs/capability-matrix.md` page
  are not in this release.
- `README.md` line 1012, under **What this slice does not do**: the same, naming the `report`
  command as what exists instead.
- `ROADMAP.md`, under **Later**: "A measured capability matrix for every harness the renderer
  supports, and a generated capability page."

The page path is therefore not a new choice; it is the path the README already promises.

## 3. The renderer's target list

The renderer's own list was read from the pinned package at runtime, not from a document and not from
the README. The command, run from this worktree after `npm ci --ignore-scripts`:

```sh
node --input-type=module -e "import('rulesync').then(m => { console.log('count', m.ALL_TOOL_TARGETS.length); console.log(JSON.stringify(m.ALL_TOOL_TARGETS)); })"
```

Raw output:

```text
count 71
["agentsmd","aiassistant","amp","antigravity-cli","antigravity-ide","antigravity-plugin","augmentcode","augmentcode-legacy","augmentcode-plugin","bob","claudecode","claudecode-legacy","cline","codebuddy","codebuff","codewhale","codexcli","commandcode","continue","copilot","copilotcli","cortexcode","crush","cursor","deepagents","factorydroid","firebender","goose","grokcli","gitlabduo","hermesagent","junie","kilo","kimi-code","kimi-code-plugin","kiro","kiro-cli","kiro-ide","musecode","mimocode","omp","opencode","opencodev1","openclaw","pi","pool","qoder","qwencode","reasonix","replit","roo","rovodev","tabnine","takt","trae","vibe","warp","xum","devin","devin-plugin","zcode","zed","zoocode","dsh","androidstudio","lettacode","claudecode-plugin","vibe-plugin","warpcli","zcode-plugin","agentsskills"]
```

Three further observations from the same package, each checked rather than assumed:

- The 71 ids are 71 distinct values (`new Set(...).size` is 71).
- All three supported targets are in the list: `claudecode`, `opencode`, `opencodev1`.
- `gemini`, `geminicli`, `windsurf` and `codeium` are **not** in the list, and a case-insensitive
  search of `node_modules/rulesync/dist/index.d.ts` for `gemini`, `windsurf` and `codeium` returns
  nothing. At this pin the renderer has no Gemini CLI target and no Windsurf target, so neither can
  be measured at all, let alone rendered.

### What a target id means, and what a supported target means

A **renderer target id** is a string `rulesync` accepts in its `targets` option. It says the renderer
knows how to write some artefacts for that harness. It says nothing about whether this build can plan
them, verify them, or describe them.

A **supported target** is a member of `SupportedTarget` in `src/core/constants.ts`. It requires an
adapter with declared managed locations, a containment reader that derives and verifies the exact
path set, tests that pin the bytes or the refusal, a matrix row, and a release note. The product
passes only supported values to the renderer because `RenderRequest.target` is that type.

The gap between 71 and 3 is therefore the size of the unbuilt product, not a missing table.

### The 71 ids are not 71 harnesses

Several ids are variants of one harness, and the product already models that: `opencode` and
`opencodev1` are two ids for one editor, and `OPENCODE_TARGETS` exists so a family is one edit. The
same shape appears upstream: `claudecode`, `claudecode-legacy` and `claudecode-plugin` all name
Claude Code, `kiro`, `kiro-cli` and `kiro-ide` name one editor, and `vibe`/`vibe-plugin`,
`zcode`/`zcode-plugin`, `kimi-code`/`kimi-code-plugin` and
`augmentcode`/`augmentcode-legacy`/`augmentcode-plugin` follow the same pattern.
Any count in this design is a count of ids. A wave counts harnesses, because a user chooses a
harness, not an id.

The list is also not sorted. The observed order places `grokcli` before `gitlabduo` and ends with a
group that includes `devin`, `zcode`, `zed`, `zoocode`, `dsh`, `androidstudio`. The page sorts the
not-measured list by codepoint so the published order is stable and does not inherit an upstream
ordering that can change without notice.

## 4. The decisions

Each decision records the rule, why the code forces it, its consequence, and the alternative that was
rejected.

### 4.1 The matrix records only targets this build renders and verifies

**Decision.** A row exists only for a target with an adapter in this build: managed locations, a
containment reader, golden or planner tests, and a matrix row whose every cell names its `testId`.
A harness the renderer supports but this build does not verify is not a row. It may appear only in a
clearly separated "not measured" list that makes no capability claim.

**Why the code forces it.** `CapabilityCell.testId` exists because the snapshot's own rule is that a
cell is edited only in the same change that moves the test observing it, and `TargetStatus` exists so
an unmeasured row can be labelled `unverified` rather than presented as `promised`. The vocabulary
already forbids the alternative in words: `unknown` "is not a soft `native` ... it is never presented
as a tick". A row without a test would be exactly the claim nobody measured.

**Consequence.** The page's measured section can only shrink or hold until an adapter lands; growth
is the section 6 work. The not-measured section is expected to be large (68 ids today) and is stated
as ids, not as harnesses and not as capabilities.

**Rejected alternative.** Rows with `status: 'unverified'` and `unknown` cells for the other ids.
`verifySnapshot` permits exactly that shape (the `unknown` refusal applies only to `promised` rows),
so it would be easy and it would be wrong: 68 rows of `[?]` read as "probably fine, not yet checked",
they bury the three rows that are evidence, and they create the impression of a measurement plan
that does not exist. The `unverified` status stays reserved for a row that is being measured in the
same change, not for a table of wishes.

### 4.2 A 71-row table assembled from upstream documentation is rejected

**Decision.** The design records the rejection, with its reason. Such a table may exist later, if at
all, only as a separate marketing artefact with `basis: upstream-doc` on every cell. It must never be
the `report` output and must never be the generated page.

**Why the code forces it.** `CellBasis` already contains `'upstream-doc'`, which shows the vocabulary
anticipated this source of evidence and named it so it cannot be confused with measurement. But a
`basis` field only labels a claim; it does not make the claim measured. A 71-row table in the
`report` output would put upstream prose in the place the product reserves for what its own tests
observed, and the `report` header says what that place means: "the committed measured matrix; the
harness remains the authority on runtime behaviour".

**Consequence.** The page never shows a tick for an unverified target. The upstream table, if
written, lives outside `report` and outside `docs/capability-matrix.md`, carries
`basis: upstream-doc` on every cell, and is labelled as documentation in its own header.

**Rejected alternative.** One table with every id and `unknown` for everything unmeasured. It is the
same failure as 4.1 with a larger blast radius: 71 rows of `[?]` present the absence of measurement
as a measurement result, and the page's first impression becomes a wall of question marks rather
than three honest rows.

### 4.3 Growing the matrix means adding a verified target, and the cost is specified

**Decision.** One new verified target is one slice, and the slice carries the checklist in section 6:
the target adapter with its managed locations and workspace-file ownership, the renderer target id in
the product's union, the containment and verification reader, golden tests, the matrix row with a
per-cell `testId`, and the release note.

**Why the code forces it.** `MANAGED_OUTPUT_DIRS` and `MANAGED_OUTPUT_FILES` are
`Record<SupportedTarget, ...>`, `expectedPaths` derives the exact path set per target, and
`verifyRender` refuses both a missing artefact and an unexpected one. A row cannot be added without
those three, and adding them without tests would put an unverified claim in `SNAPSHOT`.

**Consequence.** Growth is linear and visible. The matrix cannot outrun the adapters, and the cost of
a target is reviewable before it is promised. The first wave is therefore a set of slices, not a
backlog item that expands on contact.

**Rejected alternative.** Adding a row first and the adapter later, "so the matrix looks complete".
That is the `unknown`-as-tick failure with extra steps, and it would require editing a cell in a
change that does not move the test, which the snapshot docstring forbids.

### 4.4 The page is generated from the report, not written by hand

**Decision.** A script under `scripts/` produces `docs/capability-matrix.md` from the `report`
output, and CI fails when the committed page is stale. The CLI surface does not grow: it stays
`init`, `doctor`, `report`, `generate`, `check`.

**Why the code forces it.** `report` already verifies the snapshot against the pinned renderer before
printing (`runReport`), and its `--json` payload carries every value the page needs for the measured
rows. A hand-written page would be a second copy of the matrix, which is the drift problem the tool
removes from generated configuration. A new subcommand is refused by CONTRIBUTING without a design
change, and a new flag on `report` would put repository presentation policy on the user surface for
an artefact that is not even published (`docs/` is not in the package's `files` allowlist, and
`scripts/assert-pack.mjs` enforces that allowlist).

**Consequence.** The page cannot state a claim the command does not print. Its freshness is a CI
condition, not a reviewer's memory. Regenerating it requires a built `dist/` and the pinned renderer,
which `npm ci --ignore-scripts` plus `npm run build` already provide for every other contributor
task.

**Rejected alternative.** A `report --markdown` flag. It is smaller than a subcommand but it is still
a user-facing surface for a repository artefact, and it would make page formatting part of the
command's contract, so a README link could break a consumer of `--json` by accident. Reading the JSON
keeps the command untouched.

### 4.5 The page states its evidence basis and the unmeasured rule at the top

**Decision.** The page opens with what it is generated from, what `basis` means, that every measured
cell names the test that observes it, and that `unknown` is never a tick. It also repeats the
report's own note that the harness remains the authority on runtime behaviour.

**Why the code forces it.** `SNAPSHOT`'s docstring and the `report` header already carry this
framing. A page that dropped it would take the measured record out of the context that makes it
honest, and a reader arriving from a search result would see a table of ticks with no statement of
what a tick means.

**Consequence.** The page cannot be mistaken for a compatibility promise. The statement travels with
the file, not with the README section a reader may never open.

**Rejected alternative.** A bare table plus a link to the README. The link is exactly what a reader
who lands on the page has already failed to follow.

### 4.6 The first wave is chosen by evidence of demand, not by ease

**Decision.** A target is promoted to a row when there is recorded evidence that people using this
tool, or people who would, use that harness. Accepted evidence, in order of strength:

1. **Direct customer or user conversations.** A named practitioner asking for that harness, with the
   request recorded in the delivery issue. This is the strongest signal and the only one that
   explains why.
2. **Install volume.** npm download counts are aggregate and cannot be attributed to a harness, so
   this is a trend for the package as a whole. It can rank timing across a wave but never selects a
   target on its own.
3. **Repository usage.** Issues, discussions, examples or pull requests that name the harness, or a
   fork or downstream repository whose configuration is for that harness.

**What evidence exists today.** None is recorded in this repository, and none can be measured by it.
CONTRIBUTING forbids telemetry and phone-home, and there is no analytics package and no usage ping.
The design therefore does not invent market data and does not name a committed first target. The
shortlist below is drawn only from ids the renderer actually exposes, and the two harnesses named in
earlier discussion that the renderer does not expose are called out rather than quietly dropped.

**Candidate shortlist, from the renderer's real ids at 43.14.0:**

| Harness | Renderer id(s) | Note |
|---|---|---|
| Cursor | `cursor` | id present |
| GitHub Copilot | `copilot`, `copilotcli` | two ids; one harness for wave counting |
| Codex CLI | `codexcli` | id present |
| Cline | `cline` | id present |
| Continue | `continue` | id present, adjacent to Cline |
| Roo Code | `roo` | id present |
| Zed | `zed` | id present |
| Warp | `warp`, `warpcli` | two ids; one harness for wave counting |

**Not available at this pin:** Gemini CLI and Windsurf. Neither has a renderer id, so neither can be
measured, rendered or promised without an upstream change first. If either becomes the demand
answer, the prerequisite is a renderer upgrade or an upstream contribution, not a matrix row.

**Consequence.** Slice 8.2 lands the adapter groundwork and stops before naming a target unless the
evidence above is recorded in the delivery issue. The wave is a ranked set of harnesses, and each
harness is one slice even when it needs two ids (as OpenCode already does).

**Rejected alternative.** Choosing by ease, for example the target whose emitted shapes most resemble
OpenCode. That optimises delivery cost and produces measured rows nobody asked for. It also biases
the matrix towards harnesses that happen to be structurally similar to the three already built,
which is the opposite of a demand signal.

## 5. The page

### 5.1 What it contains

`docs/capability-matrix.md` is generated, and every section below is a pure function of the measured
record plus the renderer's id list.

**Header.** Four lines:

1. The title and one sentence: this page is generated from the committed capability snapshot and
   states what this build emits and verifies, not what a harness does at runtime.
2. The evidence basis: every measured cell names the test that observes it; `basis` is `emitted` for
   a golden that pins the bytes and `probe` for a planner test that proves a refusal; `unknown` is
   never a tick.
3. The provenance line (section 5.5 explains why it is not a wall clock).
4. How to regenerate the page, and that CI fails when it is stale.

**The matrix.** One row per measured target, one column per capability in `MATRIX_CAPABILITIES`
order, and one Evidence column. Each capability cell shows both axes as `agent / workspace`, for
example `[x] / [ ]`, because `CapabilityCell` carries two emissions and collapsing them would lose
the distinction the report exists to draw. The Evidence column names the distinct `testId` values
that back that row, so a row's evidence is visible at a glance; the per-cell detail follows in the
next table. The Status and Reach columns carry `TargetStatus` and `agentReach` as the report's
`labels` block already prints them.

**The legend.** A small table of the four emissions with their glyphs and the two axis names, using
the report's own words: `native [x]`, `emulated [~]`, `dropped [ ]`, `not measured [?]`. A dropped
cell's consequence text is the refusal or warning it produces.

**Per-target evidence.** One table per measured target with a row for every capability:
`capability | agent | workspace | basis | testId | consequence`. This is where every cell's
`testId` and `consequence` appear, including the ones shared across a row. It is also where the
"edited only with the test that moves it" rule becomes visible to a reviewer of the page.

**Permission keys.** One table of the seven `PERMISSION_CATEGORIES` as columns and the measured
targets as rows, with the emission glyph and, for a non-native key, its diagnostic code. A second
list gives each non-native key's consequence text, as the report does. Today's example: `write` is
emulated on both OpenCode targets with `W112_PERMISSION_LOSSY`, and the bare `mcp` key is not
measured on both, marked `[?]` and never a tick.

**Not measured.** A list of the renderer's target ids that have no measured row, generated from the
renderer rather than typed, sorted by codepoint. One sentence above it: this list makes no capability
claim; the renderer accepting an id is not evidence that this build renders or verifies anything for
it. The count is stated as a count of ids, with the variant note from section 3.

**Footer.** The generation command and the CI gate name.

### 5.2 Where it lives

`docs/capability-matrix.md`. The path is already stated twice in the README (lines 497 and 1012 at
this commit), so choosing another would contradict the user-facing contract.

The page is a repository artefact. `docs/` is not in the package's `files` allowlist and
`scripts/assert-pack.mjs` refuses any tarball path outside `dist/` plus the legal root files, so the
page never reaches npm. A reader of the page is a reader of the repository or of the site the
repository drives, which is the audience the README already serves.

### 5.3 The generator's interface

One repository script, no new subcommand:

```sh
node scripts/capability-page.mjs            # write docs/capability-matrix.md
node scripts/capability-page.mjs --check    # exit 1 when the committed page is stale
```

**Inputs.** Three, and each is read from a built artefact rather than typed:

1. **The measured rows** come from running `node dist/cli/main.js report --json` and parsing its
   stdout. Reading the command's own output, rather than importing the builder, guarantees that the
   snapshot passed `verifySnapshot` before a byte of the page was written, because `runReport` calls
   it first. It also means the page and the command can never disagree.
2. **The renderer's target ids** come from the single importer. The `RenderTarget` port in
   `src/render/port.ts` gains the method, and `src/render/upstream.ts` implements it by returning the
   pinned renderer's `ALL_TOOL_TARGETS` through the same lazy `loadRenderer()` it already uses. The
   script calls that method; it never imports `rulesync` itself, so the one-importer rule in
   CONTRIBUTING holds. The ids are not added to the `report` payload, because `report` does not load
   the renderer today (the only reference is a type-only import, and the module is loaded lazily
   inside `loadRenderer`, which only `generate` calls), and making the user command load the renderer
   would break it in exactly the install where the renderer is missing.
3. **The product version** comes from `dist/core/constants.js` (`PRODUCT_VERSION`), which a test
   already keeps equal to `package.json`.

`src/index.ts` exports types only, so input 3 is a deep import of a built module and input 1 is the
built CLI's own output. That is acceptable here because the script is repository tooling: `scripts/`
is outside the package's `files` allowlist, so nothing in it is a published consumer surface.

**Test inputs.** The script also accepts `--report <path>`, `--renderer-targets <path>` and
`--root <path>` so a test can feed a fixture without a built CLI, the way `scripts/assert-pack.mjs`
takes a root argument. These flags exist for the suite; the CI gate passes none of them and reads the
real build.

**Output rules.** UTF-8, LF line endings, one trailing newline, no trailing spaces, no absolute
paths, no host name, no clock value. The renderer's id list is sorted by codepoint so the published
order is stable even though the upstream order is not.

**Staleness check.** `--check` renders the page in memory and compares bytes with the committed file.
On a difference it prints the page path and the first differing line, and exits 1; it never writes.
On a match it exits 0.

### 5.4 The stale-page gate

`.github/workflows/ci.yml` gains one step, after `Build` because it needs `dist/`, in both the Linux
and the macOS job so a platform difference cannot hide:

```yaml
- name: Assert the capability page is current
  run: node scripts/capability-page.mjs --check
```

The page is deterministic, so the two jobs generate identical bytes; the step is duplicated for the
same reason every other step is, so a macOS-only difference is attributable to the platform.

### 5.5 The provenance line, not a wall clock

The page needs a "generated at" statement, and a wall-clock timestamp cannot be it. A timestamp makes
the generated bytes differ on every run, so `--check` would fail immediately after every regeneration
and the only way to keep the gate green would be to exclude the timestamp from the comparison, which
makes the page not a function of its inputs. The repository's determinism rule is explicit: the
generated bytes "must not depend on where or when the command ran" (`README.md`, Determinism), and
the lockfile records no timestamp for the same reason.

The page therefore carries a provenance line instead:

```text
Generated from farna-bootstrapper 0.2.0 against renderer rulesync 43.14.0, matrix schema version 1.
```

All three values come from the build: the product version, the pinned renderer identity that
`verifySnapshot` already checks, and the snapshot schema version. The line answers the question a
reader actually has ("what produced this, and is it current with the code?") and it is deterministic.
The CI gate answers "when": a stale page cannot merge, so the committed page is always the output of
the current commit.

### 5.6 What the page must not contain

- A wall-clock date, a host name, an absolute path or a user name.
- A tick for a target this build does not render and verify.
- A claim about runtime behaviour, performance or quality of a harness.
- A compatibility promise, or wording that reads as one.
- Any hand-maintained capability data. If a value is not in the report or the renderer's id list, it
  does not belong on the page.

## 6. The cost of a new verified target

### 6.1 The checklist

One target is one slice. Every item is required, and the slice is not done while any is missing.

1. **The renderer target id enters the product's union.** `SupportedTarget` and `TARGET_ENUM` in
   `src/core/constants.ts`. The build then fails until the `Record<SupportedTarget, ...>` tables
   below are complete, which is the intended forcing function.
2. **The target adapter declares its managed locations.** An entry in `MANAGED_OUTPUT_DIRS` and
   `MANAGED_OUTPUT_FILES`. Workspace-file ownership is part of this: which whole files at the
   repository root the target owns, as `OPENCODE_CONFIG_FILE` is owned by both OpenCode targets.
   The location table is also what `findLocationCollisions` reads, so a target that shares a
   location with an existing one is refused at config time with `F005_CONFLICT`.
3. **The mode decision is recorded.** Whether the target supports profile mode (`PROFILE_TARGETS`)
   and which capabilities force it (`PROFILE_FORCING_KINDS`), or a typed refusal as `claudecode`
   has today.
4. **The source translation and containment reader exist.** The materialised shapes the renderer
   needs (`src/materialise/`), the feature set from `renderFeatures`, the exact path set from
   `expectedPaths`, and the emitted-shape verification in `verifyRender`. A target whose shapes the
   current reader cannot verify is not a row yet.
5. **Golden tests pin the emitted bytes**, and a planner or loader test proves every refusal the row
   claims. These supply the `testId` values.
6. **The matrix row exists.** A `TargetMatrix` entry with `status: 'promised'`, `agentReach`, every
   capability cell with `basis`, `testId` and a `consequence` for each non-native value, and a
   `PermissionKeyCell` for all seven categories with its `code` where a diagnostic applies.
7. **The tests in section 7 pass**, including the page regeneration and the `testId`-in-manifest
   check.
8. **The release note lands.** A CHANGELOG entry naming the new target and its artefacts, the README
   supported-targets section and capability matrix updated, and the ROADMAP bullet moved or removed
   as the work requires.

### 6.2 How the design proves a row is honest

Five conditions, each mechanically checked, together make a claim that cannot be quietly false:

1. **Every cell names a test.** A non-null `testId` on every capability cell of a promised row, and
   the test exists in `scripts/expected-test-files.json`. Today all 21 capability cells name one of
   the six ids listed in section 2.
2. **No promised cell is unmeasured.** `verifySnapshot` refuses `unknown` on either axis of a
   promised row.
3. **No promised cell claims documentation as measurement.** A promised row may not use
   `basis: 'upstream-doc'`. That value is reserved for the separate artefact in 4.2.
4. **Every non-native cell explains itself.** The existing suite already requires a `consequence` on
   every non-native capability cell, and every non-native `PermissionKeyCell` carries one today.
   Slice 1 also gives each permission key a `testId`, so the evidence rule in item 1 holds on both
   tables.
5. **The row set equals the supported set.** The report's row ids equal `SUPPORTED_TARGETS` exactly,
   which the existing test asserts. Section 8 adds a runtime guard in `verifySnapshot` so a foreign
   row is refused rather than merely rejected by the type, because the probe in section 2 showed the
   runtime guard does not catch one today.

## 7. Test plan

The test-file set is pinned in `scripts/expected-test-files.json` and enforced by
`tests/unit/repo-hygiene.test.ts`, and the suite minimum is pinned by
`scripts/assert-test-count.mjs` (`MIN_TOTAL` is 180 at this commit). Every new file below is a
deliberate manifest edit, and a new suite raises `MIN_TOTAL` in the same change.

### The page generator

- **Determinism.** Render the page twice from the same report and id list and assert the bytes are
  identical. Assert the output contains no ISO-8601 date, no absolute path and no host name, and
  ends with exactly one newline.
- **Pure function of its inputs.** Change one emission in the input report and assert the page
  changes on that cell only; add one id to the input id list and assert only the not-measured section
  changes.
- **The stale-page gate.** Run `--check` against a temporary copy of the page with one byte changed
  and assert exit 1 naming the page path. Run it against the committed page and assert exit 0. Do not
  write to the repository in either case.
- **The gate cannot be pointed at a fixture.** The CI step passes no `--report` or
  `--renderer-targets`; a repository-hygiene test asserts the workflow step command is exactly
  `node scripts/capability-page.mjs --check`, so a later edit cannot make the gate read a fixed report
  file.

### The page contents

- **The header cannot be lost.** Assert the page contains the evidence-basis sentence, the renderer
  name and version, the product version and the snapshot schema version.
- **Every measured target has a row, and only measured targets do.** Assert the set of row ids on the
  page equals `SUPPORTED_TARGETS`.
- **The not-measured list is generated, not typed.** Assert the page's not-measured ids equal the
  renderer's `ALL_TOOL_TARGETS` minus the measured row ids, and that no measured id appears in it.
  This test uses the real pinned renderer, as the golden and integration suites already do.
- **The permission table carries the vocabulary.** Assert `write` renders `[~]` with
  `W112_PERMISSION_LOSSY` on both OpenCode rows, and that the bare `mcp` key renders `[?]` and never
  `[x]`, matching the report's own test.

### The snapshot and the row claim

- **Every measured cell's `testId` exists in the test manifest.** Walk `SNAPSHOT`, collect every
  non-null `testId`, and assert each is a file in `scripts/expected-test-files.json`. This is the test
  that would have caught a row edited without its test.
- **A promised row cannot cite documentation.** Assert no promised row has `basis: 'upstream-doc'`.
- **A promised row has no unmeasured cell**, which `verifySnapshot` already enforces, asserted again
  over the real `SNAPSHOT` rather than a clone.
- **A foreign row id is refused at runtime.** Feed `verifySnapshot` a snapshot with an extra row whose
  id is not a supported target and assert `F010_RENDERER_MISMATCH`, after section 8 adds the guard.
- **The row id is a supported target at compile time.** This is a type-level property, not a runtime
  test: `TargetMatrix.id` is `SupportedTarget`, so a row for any other id fails `npm run typecheck`.
  The runtime test above covers the case a cast would otherwise hide.
- **The test manifest and minimum count move with a new suite.** The existing
  `scripts/assert-test-count.mjs` and `tests/unit/repo-hygiene.test.ts` already refuse a deleted suite
  and an unlisted file; the slice that adds a suite updates both deliberately.

## 8. Delivery slices

Four slices, in order. Each is one pull request, and the generator, the guard and the documentation
change are separated from target work as CONTRIBUTING requires.

### Slice 1: the page generator and the CI gate for the three current rows

The user-visible outcome: `docs/capability-matrix.md` exists, matches `report`, and cannot go stale.

Files: `scripts/capability-page.mjs`; `docs/capability-matrix.md`; `.github/workflows/ci.yml` (one
step after `Build` in both jobs); `src/matrix/snapshot.ts` (`testId` added to `PermissionKeyCell`
with a value for every key, and the runtime row-id guard in `verifySnapshot`);
`src/render/port.ts` and `src/render/upstream.ts` (the target-id method through the lazy renderer
load); `scripts/expected-test-files.json` (the new test files); `scripts/assert-test-count.mjs`
(`MIN_TOTAL` raised); `README.md` (lines 497 and 1012 no longer say the page is absent);
`tests/unit/capability-page.test.ts`; `tests/unit/capability-report.test.ts` (the
`testId`-in-manifest and `upstream-doc` assertions). If the snapshot gains a `testId` on permission
keys, the report JSON gains it too, which is additive and does not change the shape of any existing
field, so the report's `schemaVersion` stays 1.

Exit criterion: `node scripts/capability-page.mjs --check` exits 0 on the committed page, exits 1
after a one-byte edit, and the CI step is green on Linux and macOS. No matrix row is added.

### Slice 2: the target-adapter groundwork and the first new verified target

The groundwork makes a target one data table instead of a new branch. `TARGET_FACTS` in
`src/core/constants.ts` declares one entry per supported target: whether profile mode can select it,
the directories and files it can own, and the region id it owns inside a shared file. Every
per-target map and list the planner and the sweep read (`PROFILE_TARGETS`, `MANAGED_OUTPUT_DIRS`,
`MANAGED_OUTPUT_FILES`, `REGION_OUTPUTS`) is derived from that table rather than written beside it,
so a target cannot be half-declared and there is no second list to keep in step. A completeness test
in `tests/unit/target-facts.test.ts` pins each derived value target by target, the region-to-file
relation, the profile list and the shared OpenCode directories. The section 6 checklist is written
into `CONTRIBUTING.md` under "Adding a verified target", so a future target author has the list where
changes are described.

The behavioural branches stay code until a target needs different behaviour. `renderFeatures`,
`assertSupportedRef` and the verifiers (`expectedPaths`, `verifyRender`) are shaped by what a target
emits and what it refuses; a facts table cannot express a capability the renderer has never been
measured against, so they change when the target that needs the change arrives, not before. They are
the section 6 items that target extends.

No synthetic target is added. The supported set stays the three targets this build renders and
verifies, and the slice does not build a test-only fourth member to exercise the table or the
verifiers. The first target is named in the delivery issue only when decision 4.6's evidence is
recorded there. If it is not, the slice delivers the table, its completeness test and the checklist
and stops. When it is named, the slice carries every item in section 6.1, and the page is regenerated
in the same pull request, which moves that harness's ids out of the not-measured list and adds one
measured row.

Exit criterion: for the groundwork alone, `TARGET_FACTS` is the only per-target list in the build,
its completeness test passes and the full gate list is green. When a target is named, the new row's
every cell names a test in the manifest, the page's measured set equals `SUPPORTED_TARGETS`, and
`check` plus the real-renderer suites are green.

### Slice 3: the next two verified targets

Two more targets, each one pull request, chosen by the same evidence ranking and delivered against
the same checklist. They are two slices of work even though they share this heading, because one
target is one slice. The page is regenerated in each.

Exit criterion: each row satisfies section 6.2, and the not-measured list shrinks by the harness's
ids (one or two, as OpenCode shows a harness can need two).

### Slice 4: documentation and the roadmap

The page becomes the README's primary capability reference: the README's hand-maintained tables are
reduced to a summary and a link, so the repository has one measured copy and no second one to drift.
CONTRIBUTING carries the section 6 checklist under the existing target rules. The ROADMAP bullet
moves from **Later** to **Shipped** when the first wave is done, and the CHANGELOG records each
target as it lands.

Exit criterion: no README table restates a cell that the page already carries; every link to
`docs/capability-matrix.md` resolves; the roadmap and changelog describe what shipped.

## 9. Risks and controls

**The page is read as a compatibility promise.** Control: the header states the evidence basis and
that the harness remains the authority on runtime behaviour; the legend says what each glyph means;
`unknown` is printed as "not measured"; and the page is generated, so its framing is not a paragraph
a later editor can drop.

**A stale page merges.** Control: the `--check` step runs in CI after `Build` in both jobs; the
generator is a pure function of the report, the renderer's ids and the product version; there is no
clock or host input, so two runs produce identical bytes.

**A row is added without the test that observes it.** Control: every capability cell needs a
non-null `testId` that exists in the test manifest; a promised cell cannot be `unknown`; a promised
row cannot cite `upstream-doc`; and the row set must equal `SUPPORTED_TARGETS`.

**A foreign row id slips in through a cast.** Control: the slice 1 runtime guard in
`verifySnapshot`, proved by the probe in section 2 that shows the guard does not exist today.

**The 68 unmeasured ids are read as harnesses, or as "probably supported".** Control: the
not-measured section says ids, states the count as ids, names the variant pattern (one harness can
have several ids), and carries the sentence that the renderer accepting an id is not evidence this
build carries anything for it.

**A renderer upgrade changes the id list without the page moving.** Control: `F010` refuses a
snapshot whose renderer version is not the pin; CONTRIBUTING's upgrade procedure already requires the
matrix to be re-measured and the snapshot updated in the same change; and the stale-page gate fails
any pull request that bumps the pin without regenerating the page.

**A docs-only contributor cannot regenerate the page without the pinned renderer.** Control: the
page needs `npm ci --ignore-scripts` and `npm run build`, the same setup every other contributor task
needs; the `--check` failure names the regeneration command; and CI regenerates the page on every
pull request, so the failure is visible and explained. The alternative, a typed id list, is rejected
in 5.3 because it would make the not-measured list a claim rather than an observation.

**The page grows into an unreadable 71-column table.** Control: it has one row per measured target
and seven capability columns, so its width is bounded by `MATRIX_CAPABILITIES`, not by the renderer's
id count. The unmeasured ids are a list, not columns.

**A target is chosen by ease and nobody uses it.** Control: decision 4.6's evidence requirement and
the stop condition in slice 2. A target with no recorded evidence is not started.

## 10. No open questions

There are no open design questions. Every choice the brief left open is settled above, and each
settled choice names its consequence and the alternative it rejected.

One maintainer action gates a slice, and it is data rather than a design decision: before slice 2
names a first target, the demand evidence described in decision 4.6 must be recorded in the delivery
issue (a named practitioner request, attributable usage evidence, or repository usage that names the
harness). Without it, slice 2 delivers the adapter groundwork and stops. This is needed before a
target is named because the alternative is choosing by ease, which decision 4.6 rejects, and a
measured row nobody asked for spends the same adapter, test and release cost as one that answers a
real request.

Two statements a reader may expect to find elsewhere are recorded here, because a search for them in
the obvious place comes up empty:

- The rule that a matrix cell is edited only in the same change that moves the test observing it is
  in the `SNAPSHOT` docstring in `src/matrix/snapshot.ts`, not in `CONTRIBUTING.md`. CONTRIBUTING
  carries the adjacent rules: a behaviour change carries its test in the same pull request, a golden
  is never edited to make a test pass, and a renderer upgrade re-measures the matrix.
- The capability report's formatter is `formatCapabilityReport` in `src/report/capability.ts`, not
  in `src/report/format.ts`, which holds the other commands' formatters and `formatJson`.
