# Multi-target rendering: design proposal

## 1. Status and scope

This is a design proposal, not shipped behaviour. Nothing in this document is implemented. It exists
because [CONTRIBUTING.md](../CONTRIBUTING.md) makes the proposal a precondition for the change:

> **Exactly one target per run.** A change that renders several targets in one invocation needs a
> per-target lockfile and mode plan; propose it as a design change first.

### The problem

The tool compiles one source tree into the configuration one coding harness reads. Today that is one
harness per invocation. `.farna/config.jsonc` names exactly one target, `generate` renders exactly
that target, and `.farna/lock.json` records exactly that target. The refusal is deliberate and typed,
but it blocks two outcomes the product is for:

1. **One source, several harnesses.** A team that uses Claude Code and OpenCode at once has to keep
   two source trees, or run the tool twice with two configs and two lockfiles. Two runs over one
   source cannot be made atomic, so a failure in the second run leaves the repository with one
   harness updated and the other not, and nothing records that state as a whole.
2. **The OpenCode half of this repository's own dogfood.** `.farna/` generates
   `.claude/agents/maintainer.md` today (the `claudecode` target in agent mode). Generating the
   OpenCode configuration from the same source needs a second target in the same run, for the same
   atomicity reason.

### What this proposal changes

A single `generate` or `check` resolves, renders and verifies every configured target, then commits
the union of their verified files behind one per-target plan and one lockfile. The config admits
more than one target, subject to a path-ownership rule enforced structurally. The lockfile moves to
schema version 2, keyed per target, and a version 1 lockfile keeps working until the next `generate`
upgrades it.

### Explicitly out of scope

This proposal does not add any of the following, and the slices in section 8 do not touch them:

- per-target `exclude` or any target filter on personas and resources;
- the full harness matrix (the `report` command still covers the three supported targets, and no
  other harness is added);
- `patch` and `replaceWith` on a resource reference;
- region ownership of shared instruction files (`AGENTS.md`, `CLAUDE.md`), which the whole-file
  ownership model does not have;
- model resources (a model stays the persona's `model` class);
- workspace resource kinds (`mcp`, `skill`, `command`, `hook`) in agent mode, which remain a refusal
  on OpenCode and are still not carried by `claudecode`.

## 2. How it works today

Every statement in this section was read from the code at the commit this note was written against.
File and symbol names are given so a reader can check each one.

### The config gate

`configSchema` in `src/config/schema.ts` is a `strictObject` whose `targets` field is a record with
four refines: at least one target (line 21), at most eight (line 22), every key in
`SUPPORTED_TARGETS` (lines 23 to 27), and finally
`Object.keys(targets).length === 1` (lines 28 to 31). The last refine is the one that makes a second
target a config error, and its message names the OpenCode pair. The schema already tolerates up to
eight keys; only the last refine stops them.

The loader, `loadConfig` in `src/config/load.ts`, parses the JSONC and returns
`configSchema.parse(parsed)`, so the refusal is `F001_INVALID_CONFIG` from the schema itself, before
any source tree is read.

### Resolution and mode

`configuredTarget` in `src/compose/resolve.ts` (line 211) returns `Object.keys(config.targets)[0]`.
It does not check that there is only one key; it takes the first and ignores the rest. The schema is
what makes "only one" true.

`resolveSource` (line 717) reads `config.targets[target]?.active` and the optional
`selection.persona`, and computes
`const mode: RenderMode = requested === undefined ? MODE_AGENT : MODE_PROFILE` (line 725). So the
mode is already computed per target: if the loop ran once per configured target, each target would
independently choose agent or profile mode from its own `active` field.

A profile selection is refused when the target does not support it
(`if (!targetSupportsProfile(target))`, line 754). `PROFILE_TARGETS` in `src/core/constants.ts`
(line 132) is `[opencode, opencodev1]`, and `targetSupportsProfile` (line 134) reads it.
`claudecode` therefore refuses `active` rather than accepting a setting that does nothing.

`notLive` is derived from `active`: it is every resolved persona id except the active one, sorted
(lines 779 to 785). Agent mode has an empty `notLive`.

### The managed locations of each target

`src/core/constants.ts` declares, per target, the locations a target can own. The comment above them
reads "The locations a target can own". `MANAGED_OUTPUT_DIRS` (line 180) is:

- `claudecode`: `[.claude/agents]`;
- `opencode`: `[.opencode/agents, .opencode/commands, .opencode/skills, .opencode/plugins]`;
- `opencodev1`: the same four directories.

`MANAGED_OUTPUT_FILES` (line 189) is `[]` for `claudecode` and `[opencode.jsonc]` for both OpenCode
targets. The code already states the consequence: "Both OpenCode targets write the same locations,
so a target switch rewrites the recorded paths in place rather than orphaning one target's output."

`isManagedOutputPath` in `src/render/orphans.ts` (line 55) iterates `SUPPORTED_TARGETS` and asks
whether a recorded path lies inside any target's managed directory or equals a managed file. It is
deliberately target-spanning so a target switch does not strand output. Ownership is reasoned about
in locations, not in a single target's plan.

### The plan and its paths

`expectedPaths` in `src/verify/containment.ts` (line 940) derives the exact managed path set from the
resolved source: one agent file per live persona at `expectedAgentPath(source.target, id)`, and, on
OpenCode only, `opencode.jsonc` when `source.mcp.length > 0`, the skill trees, the command files and
the hooks plugin when a hook is carried. Its comment is the load-bearing rule: the set is "derived
from the plan, never from `RenderResult`".

### One render

`prepareRender` in `src/render/prepare.ts` (line 143) is the whole pipeline and writes nothing into
the repository. It loads the config and the source, resolves them, computes `sourceConfigDigest`,
then inside `withStage` it materialises the rulesync source tree, calls `renderer.generate` once,
calls `verifyRender`, annotates ownership, builds the lockfile with `buildLockfile`, appends the
lockfile to the planned files, and returns.

`RenderRequest` in `src/render/port.ts` (line 23) carries one `target`. `UpstreamRenderTarget` in
`src/render/upstream.ts` has one `generate` method (line 134) that wraps `render` in
`withRenderLock`. `render` calls `assertPinned(this.identity())` (line 139), loads the renderer
lazily, changes the process working directory to `request.stageRoot` because the renderer resolves
its config against it, restores the directory in `finally`, and walks the output root.

`withRenderLock` (line 198) is a promise chain, and its comment says why: `generate` changes the
process working directory, so "two renders in one process would otherwise race on one cwd". Several
renders in one process are already serialised; multi-target rendering does not need a new
concurrency mechanism.

`renderFeatures` in `src/materialise/source-tree.ts` (line 170) derives the feature set per target
from the resolved source, and never passes the `*` wildcard.

### Verification

`verifyRender` (line 975 of `src/verify/containment.ts`) compares the expected path set with the
paths the renderer reported, refuses any difference in either direction, then reads every expected
artefact and checks its frontmatter and body against the resolved persona. It returns the exact bytes
it verified, keyed by managed path, and the comment says the caller must write those bytes: a second
read of the stage could return different bytes.

### The lockfile

`src/lock/lockfile.ts` defines the document. `lockfileDocumentSchema` (line 197) requires
`schemaVersion`, `product`, `target`, `renderer`, `personas`, `files` and `warnings`, and allows
`mode`, `activePersona`, `configDigest` and `notLive`. `buildLockfile` (line 246) writes
`schemaVersion`, `product`, `target`, `mode`, `activePersona`, `renderer`, `configDigest`,
`personas`, `notLive`, `files` and `warnings`. `serialiseLockfile` (line 315) is
`canonicalJsonFile`.

The committed dogfood lockfile shows the v1 shape with the exact keys: `activePersona`,
`configDigest`, `files`, `mode`, `notLive`, `personas`, `product`, `renderer`, `schemaVersion` and
`target`.

Two details matter for a per-target shape. First, `SCHEMA_VERSION` in `src/core/constants.ts` (line
11) is `1` and is used by the config schema (`src/config/schema.ts` line 18), the lockfile schema and
builder (`src/lock/lockfile.ts` lines 198 and 268), and the CLI JSON envelope
(`src/cli/program.ts` lines 48, 64, 161, 182, 234 and 258). One constant currently means the config
version and the lockfile version at once. Second, `canonicalJsonFile` sorts object keys recursively
(`sortValue` in `src/core/json.ts`), so a new `targets` map is canonically ordered for free, but
arrays are not sorted, so each per-target file list must still be built in codepoint order.

The reader normalises older documents rather than refusing them. `parseLockfileBytes` (line 350)
defaults `mode` from `activePersona` when the field is absent, and refuses profile mode without a
persona. That is the precedent for a v1 to v2 read path.

### The commit path

`commitFiles` in `src/render/commit.ts` (line 161) preflights every planned path with
`inspectManagedTarget` (no symlink, no directory in the way, no non-regular file), sweeps the tool's
own staging namespace in each planned directory, stages every changed file as a hidden
`.<name>.farna-tmp-<pid>-<uuid>` sibling, and renames them into place. A failure while staging
removes the temporaries and the directories this call created. A failure between renames restores
the files already replaced, re-reading each target first so a concurrent writer's newer bytes are not
overwritten, and names any file it could not restore.

`withGenerateLock` in `src/render/generate-lock.ts` (line 200) holds `.farna/.generate.lock` around
the whole read, plan, remove and commit sequence. `runGenerate` in `src/cli/commands/generate.ts`
(line 252) is the caller: it prepares, reads the recorded state, inspects the plan, checks ownership,
plans orphans, removes them, then commits. `runGenerate` writes nothing before `prepareRender` has
returned and `assertOwnership` has passed.

### The commands

`src/cli/program.ts` registers exactly five commands: `init`, `doctor`, `report`, `generate` and
`check` (line 37). `generate` and `check` each take `--persona` (lines 218 and 250). `runCheck` in
`src/cli/commands/check.ts` reads the lockfile, calls
`verifyRendererIdentity(lockfile.renderer, renderer.identity(), LOCK_PATH)` once (line 100), prepares
a render, then compares each planned file with the working tree and reports recorded paths the plan
no longer produces. The recorded set is `new Set(lockfile?.files.map((file) => file.path) ?? [])`
(line 226). There is no explicit comparison of the lockfile's `target` field with the configured
target; the comparison is the plan-versus-record path comparison, which makes a target mismatch show
up as every planned file missing and every recorded path unexpected.

`runReport` in `src/cli/commands/report.ts` reads no source tree and no config. It verifies the
capability snapshot against the pinned renderer and prints the matrix for every supported target.

`formatGenerate`, `formatCheck` and `formatDoctor` in `src/report/format.ts` each print one line of
the form `target <id> (<mode>)`.

## 3. The decisions

Each decision is settled. Each records what it costs and what was rejected.

### 3.1 The config admits more than one target, but at most one per output-path family

`claudecode` may be combined with exactly one of `opencode` and `opencodev1`. Two OpenCode majors in
one config stay refused, because they write the same locations.

**Consequence.** The final `length === 1` refine in `src/config/schema.ts` is removed. The `<= 8`
refine stays and becomes the only bound. `configuredTarget` becomes a function that returns every
configured target id in codepoint order, and the pipeline loops over it. A config that names two
output-path families is accepted; a config that names two targets of one family is refused with a
typed error that names the shared locations, raised from the config load, before any source is read
or any render happens.

**Rejected alternative.** Keep the single-target refine and add a second mechanism, such as a
`--all-targets` flag or a batch mode that runs `generate` once per target. Rejected because two runs
over one source cannot be atomic; the second run can fail after the first has written, and no single
record then describes the tree. The point of the change is one run, one plan, one commit.

### 3.2 A cross-target location-collision guard makes the rule structural

The plan computes, for each configured target, the set of managed locations that target can own, from
`MANAGED_OUTPUT_DIRS` and `MANAGED_OUTPUT_FILES`. It unions those sets and refuses if any location is
claimed by two targets. The refusal is `F005_CONFLICT` with exit 2, settled in 3.10, and it writes
nothing. The harness-family rule is
then a special case of one invariant: two OpenCode targets collide because their two location sets
are equal, and no pair of target ids is named anywhere in the guard.

The guard runs on the static table, immediately after config load, so it needs no source tree and no
renderer. That is what makes "before any render" true rather than approximate.

**Consequence.** A config with `opencode` and `opencodev1` is refused because both declare
`.opencode/agents`, `.opencode/commands`, `.opencode/skills`, `.opencode/plugins` and
`opencode.jsonc`. A future target that shares a location with an existing one is caught with no code
change. The diagnostic names the colliding locations, which is more useful than naming a target pair.

**Rejected alternative.** Compute the collision from the planned files rather than the location
table. Rejected for two reasons. A source tree with no personas and no workspace resources would plan
no OpenCode files at all, so the two majors would pass the guard and write an ambiguous lockfile
entry. And orphan removal (`isManagedOutputPath`) and the outside-ownership scan (`findSkillTreeExtras`)
already reason about locations, so a plan-level guard would disagree with the ownership model about
what a target can own.

### 3.3 Lockfile schema version 2, per target

Top-level `product` and `renderer` stay. A `targets` map, keyed by target id, carries each target's
`mode`, `activePersona` (null in agent mode), `notLive`, its `personas` and its managed `files`.
`configDigest` stays top-level because it digests the config and every source file, which are shared
by all targets. `warnings` stays top-level because every warning record already carries a `target`
field, so grouping them would duplicate it and change a record shape that has no reason to change.

**Consequence.** The schema version of the lockfile becomes 2. Because `SCHEMA_VERSION` is currently
one constant shared by the config schema, the lockfile schema and the CLI JSON envelope, it must be
split into a config version (still 1) and a lockfile version (2). `buildLockfile` becomes a
run-level builder that takes every target's resolved source and verified files. `targets` keys are
sorted by `canonicalJsonFile` automatically; each `files` array is sorted explicitly before hashing,
as `buildLockfile` already does for the flat list.

**Rejected alternative.** Bump the shared `SCHEMA_VERSION` to 2. Rejected because the config schema
did not change, `init` writes that constant into every new repository's `config.jsonc`, and the JSON
envelope version describes the CLI payload rather than the lockfile. One number for three unrelated
formats is the coupling that made this decision awkward in the first place.

### 3.4 A version 1 lockfile keeps working

Read accepts version 1 and version 2. A version 1 document is normalised in memory into the version 2
shape with one target entry. `check` against a version 1 lockfile compares the single recorded target
exactly as it does today: the plan for each configured target against the flat union of recorded
files, with recorded paths the plan no longer produces reported as drift.

A version 1 lockfile whose config now names a second target makes `check` report that target's planned
outputs as drift, because none of them is recorded. The config digest also changes when the config
gains a target, so `check` reports `.farna/lock.json` with the source-or-config-changed detail rather
than comparing that file's bytes. `generate` records the new target and writes version 2. This is a
one-time upgrade for an existing repository: the first `generate` after the tool upgrade rewrites
`.farna/lock.json`, and that rewrite is committed like any other generated change.

**Consequence.** The reader has two branches, and the in-memory `Lockfile` type is always the version
2 shape so every consumer (orphan planning, ownership checks, `check`'s recorded set) sees one form.
The flat recorded set is the union over every target entry, including an entry for a target no longer
in the config, because that union is what orphan removal and drift detection need.

**Rejected alternative.** Refuse a version 1 lockfile and require a fresh `generate`. Rejected
because `check` runs in CI for every repository that already uses the tool; refusing the lockfile
would turn an upgrade into a red build with no diagnosis. The existing normalisation of a lockfile
that predates profile mode is the precedent.

### 3.5 Every target is verified before the first byte is written

Each target renders into its own disposable stage and passes its own containment gate. Only when
every target has produced verified bytes does the commit path run, over the union of the files. A
failure in any target writes nothing.

**Consequence.** `prepareRender` splits into a per-target prepare that returns the resolved source,
the verified bytes and the target's lock entry, and a run-level step that builds the lockfile from all
of them. `withGenerateLock` still wraps the whole sequence, and `commitFiles` and its restore path are
reused unchanged. The union is de-duplicated by path; a duplicate at this point is the collision
guard's job and must already have been refused.

**Rejected alternative.** Commit each target as soon as it verifies. Rejected because a later target's
failure would leave an earlier target written and the lockfile either stale or absent, which is
exactly the mixed tree the current design spends a restore path avoiding.

### 3.6 One renderer call per target, identity checked once

N configured targets produce N renders. The pinned renderer identity is verified once per run, before
the first render. The bytes each target produces must equal the bytes a single-target run of the same
source produces; that equality is a required test, not an assumption.

**Consequence.** `assertPinned` and the identity read move out of `UpstreamRenderTarget.render` and up
to the run entry, so a bad pin fails before any stage is created. `withRenderLock` is unchanged:
renders in one process are already serialised because the renderer chdirs.

**Rejected alternative.** Run one renderer per target in parallel workers. Rejected because nothing
requires it, the renderer already serialises in-process, and giving each render its own process would
widen the `RenderTarget` seam, which CONTRIBUTING treats as a design change rather than a fix.

### 3.7 Modes are per target

`active` is a per-target field today and stays one. Each target independently computes agent or
profile mode, its live persona and its `notLive` set. Profile mode remains OpenCode-only. `--persona`
applies to every configured target that supports profile mode, and is refused with a typed error
naming the target and the persona id when the persona does not resolve for that target.

**Consequence.** The resolver is called once per target and keeps its current logic. A configured
target that does not support profile mode stays in agent mode when `--persona` is passed, and the run
states that, because otherwise a `claudecode` plus `opencode` config could not use the flag at all.
The statement is `W118_PERSONA_FLAG_NOT_APPLIED` at info severity, emitted once per configured target
that ignored the flag, with a message naming the target and the flag. It is invocation-level rather
than source-derived, so `generate` and `check` report it and it is never written into
`.farna/lock.json`, which is built from source warnings only.
If no configured target supports profile mode, the flag is refused as it is today. The refusal
message changes from `active persona "<id>" names no persona` (which names no target) to a message
that names the target and the id, because with several targets the reader must know which one failed.

Two details the code forces on this decision. Personas are declared once under `.farna/personas/` and
shared by every target, so "that target's source does not declare the persona" cannot be literally
true. What can differ per target is whether the persona resolves: a reference the target cannot carry
(a workspace kind on `claudecode`, an allow-list permission on OpenCode) is refused for that target,
and profile mode itself is refused on `claudecode`. The design uses "does not resolve for this
target" and names the target in the message. The second detail is that today `--persona` is refused
for a `claudecode`-only config by the profile-support check, which the design preserves.

**Rejected alternative.** Let `--persona` fail the whole run when any configured target cannot run
profile mode. Rejected because the two-target config that motivates this work is `claudecode` plus one
OpenCode target, and that reading would make the flag unusable in exactly that configuration.

### 3.8 The CLI surface does not grow

`generate`, `check` and `doctor` operate over every configured target. The human output gains one
section per target, settled in 3.11, and `--dry-run` and `--json` carry the per-target plan. No
subcommand and no new option is added.

**Consequence.** `GenerateResult`, `CheckResult` and `DoctorResult` each gain a per-target collection
and lose their single `target`, `mode`, `activePersona` and `notLive` fields. A JSON consumer sees one
shape whatever the config holds, rather than a single-target shape for one config and a multi-target
shape for another.

`report` is deliberately unchanged. It already prints the matrix for every supported target and reads
no source and no config, which the command's own comment calls out as making it useful in an empty
directory and in CI. Making it read the config would remove that property for no gain.

**Rejected alternative.** Add a `--target` selector or a `generate --all`. Rejected because
CONTRIBUTING forbids a new subcommand without a design change, and the config already states the set
of targets the repository wants.

### 3.9 Rollout is a minor release before 1.0, 0.2.0 by working assumption

The lockfile format and the `--json` payload change are user-visible, so the release is a minor, not
a patch. `CHANGELOG.md` carries a migration note. The README is updated in the same change, per
CONTRIBUTING. This repository's own dogfood is extended to the OpenCode half in the final slice.

**Consequence.** Per the changelog's own rule, before 1.0 a minor release may contain a breaking
change, and every such change is listed under **Changed**. The version bump and the changelog entry
land in the release pull request, as CONTRIBUTING's Releasing section requires, not with each slice.

**Rejected alternative.** Ship it silently in a patch release. Rejected because a lockfile rewritten
from version 1 to version 2 and a changed JSON payload are exactly the changes a reader needs to be
told about.

### 3.10 The location-collision refusal is `F005_CONFLICT` with exit 2

`F005_CONFLICT` already exists: `conflict` in `src/core/errors.ts` raises it, and the README's
exit-code table defines exit 2 as "a conflict between declarations", in this row:

```text
| `2` | a conflict between declarations | `F005_CONFLICT` |
```

Two targets' declarations claiming one location is exactly that, so the guard raises the existing
code and no new code is added. The code is already used for the same shape elsewhere: two resource
sources that disagree on one `(kind, id)`, two personas that disagree on one workspace resource, and
two model classes in one composed set that resolve to different concrete models.

**Consequence.** The guard raises `conflict(...)` and exits 2. One existing case changes its
diagnostic: a config naming both OpenCode targets fails today as `F001_INVALID_CONFIG` with exit 1,
raised by the `length === 1` refine in `src/config/schema.ts`, and after this change it fails as
`F005_CONFLICT` with exit 2. The F001 path for that config is removed rather than left beside the
guard, so one condition has one diagnostic. The README's exit-code table and the code tables in the
Warnings and exit codes section are updated in the same slice that lands the guard (slice 2), and the
changelog entry names the changed diagnostic.

**Rejected alternative.** Keep `F001_INVALID_CONFIG` with exit 1 for this case. Rejected because it
would either leave the schema refine in place as a second, hard-coded refusal beside the general
guard, which is what 3.2 removes, or describe a conflict between two declarations as invalid input,
when the exit-code table already gives that shape its own row and its own exit status.

### 3.11 The human report prints one section per target

Each configured target gets its own section, carrying its mode, its live persona (or the statement
that every persona is live), its `notLive` set in profile mode, and the files it produced, left
unchanged or removed.

A mixed run has no single mode to print: a `claudecode` agent target and an `opencode` profile target
would share one `target (mode)` line that describes neither. Script consumers read the `--json`
payload rather than parsing the human text, so the human output does not have to remain one flat
list. Keeping each target's mode adjacent to the files that target produced means a reader never has
to join two lists to learn which mode wrote a file.

**Consequence.** `formatGenerate`, `formatCheck` and `formatDoctor` in `src/report/format.ts` print a
per-target section, and each target's summary line counts only that target's files. The snapshot
tests for `formatGenerate` and `formatCheck` gain per-target fixtures in slice 1, including one mixed
run with an agent target and a profile target. The invocation-level
`W118_PERSONA_FLAG_NOT_APPLIED` stays in the run's warning list rather than a target's section: it
describes the flag, not a target's rendered state, and it is never recorded in the lockfile.

**Rejected alternative.** One flat file list with a target column. Rejected because the mode, the
live persona and `notLive` belong to a target rather than a file, so a column would either repeat
them on every row of that target or need a group header anyway, and in a mixed run the column hides
the mode the reader most needs.

## 4. Data shapes

### The config

A repository that wants both harness families writes:

```jsonc
{
  "schemaVersion": 1,
  "targets": {
    "claudecode": {},
    "opencode": { "active": "builder" }
  },
  "models": {
    "standard": {
      "claudecode": "claude-sonnet-4-5",
      "opencode": "anthropic/claude-sonnet-4-5"
    }
  }
}
```

`claudecode` is in agent mode and `opencode` is in profile mode with `builder` live. Each target keeps
its own `active` field and its own mode.

This config is refused, because both targets declare the same locations:

```jsonc
{
  "schemaVersion": 1,
  "targets": {
    "opencode": {},
    "opencodev1": {}
  }
}
```

A model class needs a mapping for every target that uses it. `resolveModelClass` in
`src/compose/resolve.ts` (line 261) refuses a class with no mapping for the target, so adding a target
to an existing config also means adding that key under `models`.

A model class whose mapping is missing for a configured target is an existing, per-target refusal and
is unchanged by this proposal. It only becomes more visible, because one config now uses several
targets.

### The version 2 lockfile

The shape below is illustrative; the values are not from a real run. Note the sorted `targets` keys,
the per-target `mode` and `activePersona`, and the sorted `files` arrays.

```json
{
  "configDigest": "6f1c0f5c2f4a8f3f0f0f4a1c2b3d4e5f60718293a4b5c6d7e8f9012345678abc",
  "product": {
    "name": "farna-bootstrapper",
    "version": "0.2.0"
  },
  "renderer": {
    "integrity": "sha512-fGOfX/kbs089e2nPDNZtf/nY/eNKIgM8n5Mer6f+A2ZQlxjVTjBHS60O847aCV/kZIwHHUIXASgh6aRv3VlR9w==",
    "name": "rulesync",
    "version": "43.13.0"
  },
  "schemaVersion": 2,
  "targets": {
    "claudecode": {
      "activePersona": null,
      "files": [
        {
          "path": ".claude/agents/builder.md",
          "sha256": "0a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0a1b2c3d4e5f6071",
          "size": 1420
        }
      ],
      "mode": "agent",
      "notLive": [],
      "personas": [
        {
          "digest": "1f2e3d4c5b6a798807162534435261708192a3b4c5d6e7f80910a1b2c3d4e5f",
          "id": "builder",
          "permissionDigest": "2a3b4c5d6e7f80910a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef",
          "resources": [
            {
              "fromPersona": "builder",
              "id": "builder-rules",
              "kind": "rule",
              "sha256": "3b4c5d6e7f80910a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0a"
            }
          ]
        }
      ]
    },
    "opencode": {
      "activePersona": "builder",
      "files": [
        {
          "ownedKeys": ["mcp"],
          "path": "opencode.jsonc",
          "sha256": "4c5d6e7f80910a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0a1b",
          "shape": "structured",
          "size": 210
        },
        {
          "path": ".opencode/agents/builder.md",
          "sha256": "5d6e7f80910a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0a1b2c",
          "size": 1388
        }
      ],
      "mode": "profile",
      "notLive": ["reviewer"],
      "personas": [
        {
          "digest": "6e7f80910a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0a1b2c3d",
          "id": "builder",
          "permissionDigest": "7f80910a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0a1b2c3d4e",
          "resources": [
            {
              "fromPersona": "builder",
              "id": "builder-rules",
              "kind": "rule",
              "sha256": "80910a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0a1b2c3d4e5f"
            }
          ]
        }
      ]
    }
  },
  "warnings": [
    {
      "code": "W109_PROFILE_BY_CHOICE",
      "message": "profile mode is active for opencode as builder, but the live persona declares no capability that requires it; agent mode is the default, and reviewer is not live",
      "persona": "builder",
      "severity": "info",
      "target": "opencode"
    }
  ]
}
```

Every key of every entry is the same key the version 1 document uses today. The `personas` array can
differ between targets for the same persona id, because the resolved resources are target-filtered
(a hook an OpenCode target cannot carry is still resolved, but its carried state and its warnings are
per target) and because `digest` and `permissionDigest` are computed from the target's resolved
permission mapping.

### The migration rule from version 1

Reading a version 1 document produces this in memory:

```text
targets = {
  [document.target]: {
    mode: document.mode ?? (document.activePersona != null ? "profile" : "agent"),
    activePersona: document.activePersona ?? null,
    notLive: document.notLive ?? [],
    personas: document.personas,
    files: document.files
  }
}
```

The rest of the document is carried over unchanged: `product`, `renderer`, `configDigest` and
`warnings`. The existing normalisation of `mode` from `activePersona` (in `parseLockfileBytes`) is
kept, and the profile-without-persona refusal is kept.

Writing always produces version 2. A repository that does nothing but upgrade the tool sees one
`generate` rewrite `.farna/lock.json`, and `check` continues to pass on the old bytes until then.

## 5. The execution order of one run

The sequence below is a `generate`. `check` shares steps 1 to 8 and compares instead of committing.

1. **Load the config.** `loadConfig` parses and validates `.farna/config.jsonc`. Guarantee: a
   malformed config is `F001` and nothing has been read or written.
2. **Refuse a location collision.** Compute each configured target's managed locations from
   `MANAGED_OUTPUT_DIRS` and `MANAGED_OUTPUT_FILES`, union them, and refuse if any location is
   claimed twice. Guarantee: the refusal is typed, deterministic, needs no source and no renderer,
   and zero writes have happened.
3. **Take the single-writer lock.** `withGenerateLock` creates `.farna/.generate.lock` with the
   owner pid. Guarantee: a second live `generate` is a typed error, and the lock is released in a
   `finally` even on failure.
4. **Load the source tree once.** `loadSource` reads personas, rules, permissions, MCP servers,
   skills, commands and hooks. Guarantee: every source path is `lstat`-checked and a symlink is
   refused before it is read.
5. **Resolve every target.** For each configured target, call the resolver with that target's
   `active` field and the `--persona` selection. Guarantee: each target computes its own mode, live
   persona and `notLive`; a persona that does not resolve for a target is a typed error naming the
   target and the id, before any render.
6. **Compute the source digest once.** `sourceConfigDigest` hashes the raw config bytes, the parsed
   config and every persona and resource file. Guarantee: an edit that changes no rendered byte is
   still visible to `check`.
7. **Render each target into its own stage.** For each target, materialise the rulesync source tree,
   call `renderer.generate` once, and walk the output. Guarantee: renders are serialised in-process
   by `withRenderLock`, the stage is removed in a `finally`, and nothing is written into the
   repository.
8. **Verify each target.** Run the containment gate over each target's expected path set and the
   bytes it produced, and keep the verified bytes. Guarantee: fail-closed before any write; a target
   that drops, invents or corrupts a declared artefact aborts the run with zero writes.
9. **Build the lockfile.** From every target's resolved source and verified files, build one version
   2 document, with sorted target keys and sorted file lists, and append it to the planned set.
   Guarantee: determinism; no timestamp, hostname, absolute path, user name or process id.
10. **Inspect the union of planned paths.** `inspectManagedTarget` on each path refuses a symlink,
    a directory in the way, or a non-regular file. Guarantee: the plan reports only states the write
    path would accept.
11. **Check ownership.** Refuse an unrecorded planned path whose bytes differ from a fresh render,
    unless `--adopt` was passed, and refuse a missing lockfile when planned outputs already exist.
    Guarantee: the tool never takes over bytes it cannot prove it wrote.
12. **Plan and remove orphans.** Every recorded path, across the flat union of all target entries,
    that the new plan no longer produces is preflighted and then removed, or rewritten in place for
    a structured file that still carries user keys. Guarantee: only a recorded regular file in a
    managed location whose bytes still match the recorded digest is removed.
13. **Commit the union atomically.** `commitFiles` preflights, sweeps its own staging namespace,
    stages as hidden siblings and renames into place. Guarantee: atomicity per file, restore of
    already-replaced files on a rename failure, and a diagnostic naming anything it could not
    restore.
14. **Release the lock.** Guarantee: the lock is gone, and a leftover staging sibling is ignored by
    `check` and swept by the next `generate`.

`--dry-run` stops after step 11 and reports the plan: the per-target files with `unchanged` or
`would-write`, and the orphans with `would-remove` or `would-update`. It never removes or writes.

## 6. Failure modes and diagnostics

**Two OpenCode targets are configured.** The collision guard runs at step 2, before any source is
read. Nothing is written. The refusal is `F005_CONFLICT` with exit 2, and it names the shared
locations, `.opencode/agents`, `.opencode/commands`, `.opencode/skills`, `.opencode/plugins` and
`opencode.jsonc`, and says that the two OpenCode majors write the same locations. This is the one
existing case whose diagnostic changes: the same config fails today as `F001_INVALID_CONFIG` with
exit 1 from the config schema refine, and fails after slice 2 as `F005_CONFLICT` with exit 2.

**A path collision in general.** The same step, code and exit status. If a future target shares a
location with an existing one, the message names the location and both target ids, and nothing is
written. This case cannot arise with the three targets supported today beyond the OpenCode pair,
which is why the guard's generality is proved by a direct unit test over a synthetic location table.

**A version 1 lock with a second target now configured.** `check` reads and normalises the version 1
document, resolves both configured targets, and reports every planned file for the new target as
`missing`. It also reports one drift item at `.farna/lock.json` with kind `modified` and the detail
"the source or config changed since the lockfile was written; re-run generate". That item is not a
byte comparison of the lockfile. `prepareRender` appends the lockfile to the planned set with the
bytes of a fresh render, and `runCheck` deliberately skips comparing those bytes when the recorded
`configDigest` differs from the fresh one. What differs is the digest, because adding a target
changes the raw bytes of `config.jsonc`, which `sourceConfigDigest` hashes. Were the digest equal,
the bytes would be compared and would also differ, because a version 1 document is not the version 2
document a fresh render produces. The human output shows each target's drift under that target's
section. `generate` then writes the new target's files and the version 2 lockfile. Nothing is written
by `check`.

**A target is removed from the config.** `generate` resolves the remaining targets, and the removed
target's recorded files are orphaned. Each is removed only if it is a recorded regular file in a
managed location whose bytes still match the digest; `opencode.jsonc` is rewritten in place if it
still carries the user's own keys. The lockfile is rewritten without that target's entry. `check`
reports each recorded path that the plan no longer produces as drift until `generate` runs.

**A mid-commit failure.** No target's files are written until every target has verified, so a failure
during staging removes the staged siblings and any directories this run created, and reports
"nothing was written". A failure between renames restores the files already replaced, re-reads each
target first so a concurrent writer's newer bytes are not overwritten, and names any file it could
not restore. The lockfile still records the affected paths, so `check` reports the tree accurately
and a re-run can finish the job. The diagnostic names the removals this run already made, as
`commitFailure` does today.

**A renderer identity mismatch.** The pin is verified once, before the first stage is created. A
different version or a recorded integrity that differs from the pin is `F010_RENDERER_MISMATCH` with
exit 5, and nothing is written. If the integrity cannot be verified at all, the version check still
applies and `W114_RENDERER_INTEGRITY_UNVERIFIED` is reported by the command and kept out of the
lockfile, as it is today.

**`--persona` names a persona that does not resolve for a target.** Step 5 refuses with a typed error
that names the target and the persona id. Nothing is written. If the persona exists but a reference
it declares cannot be carried by that target, the error is the existing per-target refusal for that
reference, with the target named. If the target does not support profile mode, it stays in agent mode
and the run says so; if no configured target supports profile mode, the flag is refused as it is
today.

## 7. Test plan

The test-file set is pinned in `scripts/expected-test-files.json` and enforced by
`tests/unit/repo-hygiene.test.ts`, so every new file below is a deliberate manifest edit. The suite
count is pinned by `scripts/assert-test-count.mjs`, so no suite may be deleted or skipped to make
the change pass.

### Unit

- **The location-collision guard.** One test over the real `MANAGED_OUTPUT_DIRS` and
  `MANAGED_OUTPUT_FILES`: `opencode` plus `opencodev1` is refused and `claudecode` plus `opencode` is
  accepted. One test over a synthetic table where a third target shares one directory with
  `claudecode`, proving the guard is not a hard-coded pair. One test that the refusal happens before
  any render by passing a renderer that throws if called.
- **The collision diagnostic.** A config with both OpenCode targets is refused as `F005_CONFLICT`
  with exit 2, while the config schema on its own accepts it, proving the refusal moved from the
  schema refine to the guard and that only one refusal path exists.
- **The version 1 reader.** A version 1 document is normalised into one target entry; the profile
  default from `activePersona` is kept; a profile document with no persona is still refused.
- **The version 2 writer.** Target keys and every file list are canonically ordered, two writes of
  the same input produce identical bytes, and the document validates against its own schema.
- **The schema split.** The config schema still accepts `schemaVersion: 1` and the lockfile schema
  accepts 2, proving the two versions are no longer one constant.
- **Per-target modes.** `claudecode` in agent mode plus `opencode` in profile mode resolve to one
  agent target and one profile target, each with its own `notLive`.
- **`--persona` semantics.** Applied to the profile-capable target; refused when no configured target
  supports profile mode; refused with the target named when the persona does not resolve for it.
- **Per-target orphan planning.** A recorded path for a target no longer in the config is planned
  for removal, and a recorded path that is still produced by another target is not.
- **Per-target report formatting.** `formatGenerate`, `formatCheck` and `formatDoctor` print one
  section per target with that target's mode and live persona, and a mixed run with an agent target
  and a profile target prints both.

### Integration

- **The version 1 to version 2 upgrade.** `generate` on a repository holding a version 1 lockfile
  writes a version 2 lockfile whose content matches the version 1 record, and `check` then passes.
- **A version 1 lock plus a second target.** `check` exits 1 and reports the new target's planned
  files as drift; `generate` records them and `check` then exits 0.
- **Collision refusal with zero writes.** `generate` on a config with two OpenCode targets exits
  non-zero and the tree is byte-identical to before, including the absence of a lockfile when there
  was none.
- **N renders equal N single-target runs.** Render one source with `{ claudecode }`, with
  `{ opencode }`, and with both, through the real pinned renderer. The per-target files from the
  combined run are byte-identical to the files from the corresponding single-target runs.
- **All-or-nothing verification.** A renderer that fails on the second target leaves the tree
  untouched, using the existing mutating-renderer support in `tests/support`.
- **A renderer that lists a file it did not write** on the second target leaves the tree untouched.
- **Two-target dogfood.** A fixture with one persona, one rule and one permission resource generates
  both a `.claude/agents/<id>.md` and a `.opencode/agents/<id>.md`, and `check` passes on the result.
  This may reuse the `examples/` trees by adding a second target to a copied config.

### Golden

- **The OpenCode artefact under a combined config** is byte-identical to the existing OpenCode golden
  for the same source, proving that a second target in the config does not change the first target's
  bytes.
- **The Claude Code artefact under a combined config** is byte-identical to the existing Claude Code
  golden for the same source, for the same reason.

No existing golden may change as part of this work. If one does, the source change that moved it must
be explained, per CONTRIBUTING.

## 8. Delivery slices

Four slices, in order. Each is one pull request. The refactor and the behaviour change are separate
pull requests, as CONTRIBUTING requires.

### Slice 1: the per-target plan and the version 2 lockfile, with one configured target

The internal shape changes. The user-visible differences are the lockfile format and the shape of
the `generate`, `check` and `doctor` results: each loses its single `target`, `mode`,
`activePersona` and `notLive` fields and gains one per-target entry, in both the `--json` payload
and the human output. The one-target config refine stays in place, so no config that is valid
today becomes invalid, and no config that is invalid today becomes valid.

Files: `src/core/constants.ts` (split the config and lockfile schema versions),
`src/compose/resolve.ts` (a function that returns the configured targets; the single-target path
calls it), `src/render/prepare.ts` (per-target prepare without the lock build),
`src/lock/lockfile.ts` (the version 2 document, the reader for both versions, the run-level builder),
`src/cli/commands/generate.ts`, `src/cli/commands/check.ts`, `src/cli/commands/doctor.ts`,
`src/report/format.ts`, `src/cli/program.ts` (the per-target payload), and the tests listed above
that do not concern collisions.

The `formatGenerate` and `formatCheck` snapshot fixtures gain their per-target cases here, including
one mixed run with an agent target and a profile target, because slice 1 is where those formatters
change.

Exit criterion: with one configured target, `generate` writes a version 2 lockfile whose target
entry reproduces the version 1 fields exactly; `check` passes against a version 1 lockfile and
against the version 2 file it just wrote; `generate` upgrades a version 1 lockfile; every existing
golden is unchanged; the full gate list in CONTRIBUTING passes, plus `node dist/cli/main.js check`
in this repository.

### Slice 2: `claudecode` plus one OpenCode target in agent mode

The config admits a second family. The location-collision guard lands. Agent mode only; a profile
selection on any target is a separate slice.

Files: `src/config/schema.ts` (remove the `length === 1` refine, so the location rule is the only
refusal), `src/config/targets.ts` (new: the one `configuredTargets(config)` helper, codepoint
sorted), `src/config/collision.ts` (new: a pure collision function over a target-to-locations
table, its application to `MANAGED_OUTPUT_DIRS` and `MANAGED_OUTPUT_FILES`, and its
`F005_CONFLICT` diagnostic), `src/config/load.ts` (the guard runs after the schema parses and
before `loadConfig` returns, so every command inherits it before any source is read or any render
is planned), `src/render/prepare.ts` and `src/cli/commands/doctor.ts` (use the shared helper;
`prepare.ts`'s copy is removed), `README.md` (the exit-code and code tables, plus every place in
Targets and Supported targets that says a two-OpenCode config is `F001`, and the statements that
one target is rendered per run), `CONTRIBUTING.md` (the per-run target rule), and the unit and
integration tests for collisions, for the changed diagnostic and for N renders equal to N runs.

Placement note: the configured-target helper lives in `src/config/targets.ts`, not in
`src/compose/resolve.ts` as this note first proposed. The guard runs at config load, so the helper
must not live in the compose layer; keeping it in `config/` is what lets `loadConfig` enforce the
rule without depending on composition. `src/compose/resolve.ts` keeps its single-target
`configuredTarget` for the per-target scoped config slice 1 passes it.

Exit criterion: a config with `claudecode` and `opencode` in agent mode generates both, `check` passes,
a config with both OpenCode targets is refused as `F005_CONFLICT` with exit 2 and zero writes, the
config schema alone accepts that config, the README names `F005_CONFLICT` with exit 2 for it, and
removing the second target from the config removes its recorded output on the next `generate`.

### Slice 3: multi-target profile mode and the `--persona` semantics

A second target may run profile mode while another runs agent mode, and `--persona` is defined across
the set.

Files: `src/compose/resolve.ts` (per-target mode selection and the target-named refusal),
`src/cli/commands/generate.ts`, `src/cli/commands/check.ts`, `src/cli/commands/doctor.ts`,
`src/cli/program.ts` and `src/report/format.ts` (the per-target sections), and the unit and
integration tests for per-target modes and `--persona`.

Exit criterion: a config with `claudecode` in agent mode and `opencode` in profile mode generates and
checks both; `--persona` selects the persona on the profile target and leaves the agent target in
agent mode; a persona that does not resolve for a target is refused with the target and the id named;
a config with no profile-capable target still refuses the flag.

### Slice 4: documentation and the dogfood switch

The README, CONTRIBUTING and ROADMAP describe multi-target rendering as shipped, the CHANGELOG
carries the migration note, and this repository's own `.farna/config.jsonc` gains the OpenCode target.

Files: `README.md` (Status, Targets, Output layout, Determinism, the lockfile section, What this
slice does not do, and the dogfood section), `CONTRIBUTING.md` (the multi-target bullet and the
"adding a target" guidance), `ROADMAP.md`, `CHANGELOG.md`, `.farna/config.jsonc`, the regenerated
`.farna/lock.json` and `.opencode/agents/maintainer.md`.

The dogfood switch needs two small edits beyond the target key. The `maintainer` persona uses
`model: standard`, and `resolveModelClass` refuses a class with no mapping for the target, so
`models.standard` needs an `opencode` entry. And `.gitattributes` and `.gitignore` already contain
every OpenCode path and the staging pattern, so no `init` re-run is needed for them.

Exit criterion: `node dist/cli/main.js generate` writes both targets, `check` exits 0 in CI, the
lockfile is version 2 with two target entries, and the README no longer says that exactly one target
is rendered per run.

## 9. Risks and controls

**A repository's lockfile changes format on upgrade.** Control: the reader accepts both versions, so
`check` keeps working before `generate` runs; the migration is one `generate` and one committed file;
the CHANGELOG names it; and an integration test covers the upgrade path.

**A second target changes the first target's bytes.** Control: per-target stages and per-target
verification, plus the golden test that compares a combined run's Claude Code and OpenCode artefacts
against the existing single-target goldens.

**A partially written tree after a failure.** Control: every target verifies before the first write,
so a render or verification failure writes nothing; the existing restore path covers a failure during
the commit; and the diagnostic names what was already removed or replaced.

**The collision guard is too coarse and refuses a legitimate pair.** Control: the guard reads the
static location table, which is the same table orphan removal and outside-ownership scanning already
use, so it cannot refuse something the ownership model would allow. With the three supported targets
it refuses only the OpenCode pair.

**The collision guard is too narrow because it reads a static table rather than the plan.** Control:
accepted deliberately. Two targets that can both own a location make ownership of that location
ambiguous even when today's declarations produce no shared file, and the lockfile records ownership
by path. The plan-level alternative is discussed and rejected in section 3.2.

**Two targets, two modes, and a user who expects one.** Control: the human output prints one section
per target with its own mode and live persona, and the per-target `notLive` set. The JSON payload
carries the same, so a script never has to infer a mode.

**The `--json` payload change breaks a consumer.** Control: the change is a minor release before
1.0, it is listed under **Changed**, and the payload has one shape for one target and several, so a
consumer does not have to handle two shapes.

**The dogfood's OpenCode output surprises a reviewer.** Control: the slice 4 pull request names the
new files and the regenerated lockfile, and CI's `check` proves the committed output matches the
source.
