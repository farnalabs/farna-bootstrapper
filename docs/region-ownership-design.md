# Region ownership and Claude Code profile mode: design proposal

## 1. Status and scope

This is a design proposal, not shipped behaviour. Nothing in this document is implemented. It
records a change to the ownership model and a change to one target's profile mode, and every
statement about the current code or about what the renderer emits was observed at the commit this
note was written against.

### The problem

The tool owns whole files. A managed path is either a whole file it writes and compares byte for
byte, or a whole file whose declared top-level keys it owns and merges in place
(`opencode.jsonc`, key `mcp`). There is no way to own a marked part of a file.

That blocks two things.

1. **A shared instruction file cannot be owned safely.** `CLAUDE.md` and `AGENTS.md` are edited by
   people and by other tools. Whole-file ownership would overwrite every byte outside the tool's
   output, and whole-file comparison would report a user's own edit as drift. The only honest
   option today is to refuse the file.
2. **Claude Code has no profile mode.** Profile mode needs a workspace a single persona owns. On
   the OpenCode targets that workspace is `opencode.jsonc` plus the `.opencode/` trees. Claude Code
   keeps its always-on instructions in `CLAUDE.md`, which the tool cannot own as a whole file, so
   `claudecode` refuses `active` with `F001_INVALID_CONFIG` rather than accepting a setting that
   does nothing (`src/compose/resolve.ts:resolveSource`, line 753; `PROFILE_TARGETS` in
   `src/core/constants.ts`, line 147).

The region primitive is the precondition for the second. A managed region lets the tool write one
persona's instruction text into a shared `CLAUDE.md` and compare only that text.

### What this proposal changes

A managed text file may carry one or more marked regions. A region is delimited by two marker
lines, and the lockfile records the SHA-256 and size of the body between them. `check` compares
only the body. Bytes outside a region are the user's and are never drift. `generate` replaces a
region body in place and refuses an unmarked file unless `--adopt` is passed.

With that primitive, `claudecode` gains profile mode. Exactly one persona is live. The live
persona's agent file, its MCP servers, its hooks and its instruction text are emitted on the
surfaces the pinned renderer produces for `claudecode`. The instruction text lands in a region of
`CLAUDE.md`.

### Explicitly out of scope

This proposal does not add, and the slices in section 10 do not touch:

- nested regions, or a region whose body contains another region;
- ownership of an arbitrary user file: the tool owns only a path it plans and records, never a file
  it finds by name;
- two targets owning two regions of one file; one file has one owning target;
- a general-purpose Markdown editor; the body is replaced as bytes and never parsed or reformatted;
- `AGENTS.md` as a shipped surface. The primitive is target-neutral, but the only instruction file
  the pinned renderer names for a supported target is `CLAUDE.md` (measured in section 3);
- skills and commands on `claudecode`, which the renderer can emit but this design does not carry
  (section 8 records why).

## 2. How ownership works today

Every statement in this section was read from the code at the commit this note was written against.
File and symbol names are given so a reader can check each one.

### Whole files

A managed path with no declared ownership shape is a whole file. `commitFiles` in
`src/render/commit.ts` (line 161) preflights every path with `inspectManagedTarget` (line 98),
stages each changed file as a hidden `.<name>.farna-tmp-<pid>-<uuid>` sibling, renames it into
place, and restores already replaced files if a later rename fails. The lockfile records the whole
file's SHA-256 and byte size (`lockFilesOf` in `src/lock/lockfile.ts`, line 332). `check` compares
the whole file's bytes (`src/cli/commands/check.ts:compareFile`, line 222).

### Structured files and the keys they own

`STRUCTURED_OUTPUTS` in `src/render/structured.ts` (line 17) is the only table of partial
ownership. It has one entry: `opencode.jsonc` owns the top-level key `mcp`. `structuredOwnedKeys`
(line 22) is how every consumer asks whether a path is partial. `mergeStructuredText` (line 284) is
a byte-preserving edit: it sets or deletes only the owned key's value range, preserving comments,
whitespace, key order and every other member. The lockfile records the digest and size of the owned
subset, not the whole file (`structuredOwnedDigest`, line 67). `check` compares the canonical owned
subset (`check.ts`, line 187). Orphan removal deletes only the owned key when the file still carries
user keys (`src/render/orphans.ts:inspectOrphan`, line 84).

### The lock entry shapes

`LockEntryShape` in `src/lock/lockfile.ts` (line 35) is `'whole' | 'tree' | 'structured' |
'region'`. The entry type `LockFileEntry` (line 37) carries `path`, `sha256`, `size`, an optional
`shape`, and optional `ownedKeys`. `lockFileEntrySchema` (line 180) is a strict object whose
`superRefine` requires `ownedKeys` for a `structured` entry and forbids `ownedKeys` on every other
shape.

Two members of that vocabulary are declared but not produced. Nothing writes `tree`, and nothing
writes `region`; only `whole` and `structured` appear in a lockfile this build writes. This matters
for the design: a hand-edited lockfile that sets `shape: "region"` today validates, because the
enum allows it and the refinement says nothing about `regionId`, and then every consumer treats it
as a whole file. `check` would compare the whole file, and orphan removal would remove it
(`check.ts`, line 222; `orphans.ts`, line 118). The design closes that gap in the same slice that
starts producing region entries.

### Orphan removal

`isManagedOutputPath` in `src/render/orphans.ts` (line 55) accepts a recorded path only when it is
inside one of `MANAGED_OUTPUT_DIRS` for one of the supported targets, or equals one of their
`MANAGED_OUTPUT_FILES`. `inspectOrphan` (line 84) then refuses a symlink, a directory, a non
regular file, or bytes that no longer match the recorded digest. A `structured` entry is handled by
key; every other shape is handled as a whole file. `planOrphans` (line 199) performs the preflight
without writing, and `removeOrphans` (line 267) re-checks each path immediately before the `rm`.

### The location-collision guard

`findLocationCollisions` in `src/config/collision.ts` (line 33) is a pure function over a
target-to-locations table. `managedLocationsOf` (line 55) builds each target's locations from
`MANAGED_OUTPUT_DIRS` and `MANAGED_OUTPUT_FILES` in `src/core/constants.ts` (lines 195 and 204).
`assertNoLocationCollisions` (line 80) runs at config load, before any source is read or any render
is planned, and refuses a location two targets claim with `F005_CONFLICT` (exit 2).

Today `claudecode` claims `.claude/agents` and no whole file. `MANAGED_OUTPUT_FILES.claudecode` is
`[]`. A region path that is not in either table is therefore not a claimed location, is not
removable as an orphan, and does not collide with anything.

### The expected path set and verification

`expectedPaths` in `src/verify/containment.ts` (line 940) derives the managed path set from the
resolved source, never from the renderer's own report. For `claudecode` it is one agent file per
live persona and nothing else (`expectedAgentPath`, line 26). `verifyRender` (line 975) refuses a
missing or invented path, reads every expected artefact, and checks the Claude agent frontmatter
and body against the resolved persona. It returns the exact bytes it verified, and the caller writes
those bytes.

`renderFeatures` in `src/materialise/source-tree.ts` (line 170) decides what the renderer is asked
for. For `claudecode` it returns `['subagents']` unconditionally. `materialiseSourceTree` (line 334)
writes `subagents/<id>.md` and returns early for `claudecode` (line 346), so no rule, MCP or hook
source is authored. `personaBody` (line 26) joins a persona's rule bodies into the agent body, and
it is the only rule carrier on either target: there is no shared root rule file.

### The exact code that decides whole versus structured

`annotateOwnership` in `src/render/prepare.ts` (line 77) is the only producer of a non-whole entry.
It asks `structuredOwnedKeys(file.path)`. When that returns `undefined` the file keeps no shape and
is recorded whole. When it returns keys and the generated document carries at least one, the entry
becomes `structured` with the owned subset's digest and size. There is no other shape decision in
the pipeline.

### The gap

Nothing in the current model can own a region. `STRUCTURED_OUTPUTS` is keyed by path and owns JSON
keys, not text ranges. The lock vocabulary names `region` but no code produces, validates, merges,
compares or removes one. `claudecode` has no workspace output the tool owns, so profile mode has
nothing to make one persona live for. Both gaps are closed below.

## 3. The measurement

The measurements were run against the pinned renderer, `rulesync` 43.14.0, through the built CLI
and directly through the renderer module. The probe sources and outputs live under
`/tmp/opencode/region-probe/`, outside the repository. No file in the worktree was modified for a
probe.

### 3.1 The tool's own path for `claudecode`

Command, in a scratch source tree with one `claudecode` target, two personas, one rule and one
non-default permission:

```sh
node /home/dev/Farna/Repos/farna-bootstrapper/.agents/worktrees/design-regions/dist/cli/main.js generate
```

The exact emitted tree was:

```text
.claude/agents/builder.md
.claude/agents/reviewer.md
.farna/lock.json
```

`builder.md` carried `name`, `description`, `model` and `disallowedTools: [Bash]` in its
frontmatter, then the `## House style` rule body. `reviewer.md` carried `name` and `description`.
The lockfile recorded both paths with a whole-file `sha256` and `size`; no `shape` key was present.
The non-default permission produced `W111_ASK_DOWNGRADED` at medium severity, because `shell: ask`
has no per-agent Claude Code surface and is emitted as deny. `.mcp.json`, `.claude/settings.json`
and `CLAUDE.md` did not appear.

### 3.2 Each workspace-capable resource on `claudecode`

Each resource was added to a separate copy of the same source tree, one at a time. Every run exited
1 and wrote nothing:

```text
F001_INVALID_CONFIG .farna/personas/builder.yaml
  the mcp resource kind is not carried by claudecode in this slice
  render this source for the opencode target, or remove the mcp reference
```

```text
F001_INVALID_CONFIG .farna/personas/builder.yaml
  the hook resource kind is not carried by claudecode in this slice
  render this source for the opencode target, or remove the hook reference
```

The `skill` and `command` runs produced the same message with their own kind. The refusal is
`assertSupportedRef` in `src/compose/resolve.ts` (line 331), which contains an unconditional check
for `target === 'claudecode'` and `OPENCODE_WORKSPACE_KINDS` (lines 351 to 357). It is a source
refusal, before materialise and before the renderer is called.

A config with `"claudecode": { "active": "builder" }` was also run. It exited 1 with:

```text
F001_INVALID_CONFIG .farna/config.jsonc
  the claudecode target does not support profile mode
  remove the active persona for claudecode; profile mode is supported for: opencode, opencodev1
```

### 3.3 The pinned renderer with every feature

The renderer can emit more than the tool asks it for. A direct probe fed `rulesync` a hand-written
source tree and asked for `rules`, `mcp`, `subagents`, `commands`, `skills`, `hooks` and
`permissions`. The probe source:

```js
// /tmp/opencode/region-probe/renderer-probe.mjs
// Direct probe of the pinned renderer (rulesync 43.14.0) for the claudecode
// target, with every feature the tool could ask for. Input is a hand-authored
// rulesync source tree; output is a separate directory. Nothing in the
// repository worktree is modified.
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = '/tmp/opencode/region-probe/renderer';
const src = join(root, 'src');
const out = join(root, 'out');

async function put(path, content) {
  const absolute = join(src, path);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}

async function walk(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute, base)));
    else if (entry.isFile()) files.push(absolute.slice(base.length + 1));
  }
  return files.sort();
}

await mkdir(src, { recursive: true });
await mkdir(out, { recursive: true });

await put('rules/project.md', `---
root: true
targets: ["claudecode"]
description: Probe rule
---
PROBE_RULE_BODY Root instruction text.
`);
await put('subagents/builder.md', `---
name: builder
targets: ["claudecode"]
description: Probe persona
claudecode:
  model: claude-sonnet-4-5
---
PROBE_PERSONA_BODY
`);
await put('mcp.jsonc', JSON.stringify({
  mcpServers: {
    scan: { type: 'stdio', command: 'npx', args: ['-y', 'probe-mcp'] },
  },
}, null, 2));
await put('commands/probe-command.md', `---
description: Probe command
targets: ["claudecode"]
---
PROBE_COMMAND_BODY
`);
await put('skills/probe-skill/SKILL.md', `---
name: probe-skill
description: Probe skill
targets: ["claudecode"]
---
PROBE_SKILL_BODY
`);
await put('hooks.jsonc', JSON.stringify({
  version: 1,
  hooks: {
    preToolUse: [{ matcher: 'Edit', type: 'command', command: 'probe-hook' }],
  },
}, null, 2));
await put('permissions.jsonc', JSON.stringify({
  permission: {
    bash: { '*': 'ask' },
    edit: { '*': 'deny' },
    read: { '*': 'allow' },
  },
}, null, 2));

const { generate } = await import(
  '<worktree>/node_modules/rulesync/dist/index.js'
);
const previous = process.cwd();
process.chdir(root);
try {
  const result = await generate({
    targets: ['claudecode'],
    features: ['rules', 'mcp', 'subagents', 'commands', 'skills', 'hooks', 'permissions'],
    inputRoots: [src],
    outputRoots: [out],
    configPath: 'rulesync.jsonc',
    delete: false,
    dryRun: false,
    check: false,
    silent: true,
  });
  console.log(JSON.stringify({
    sourceLoadFailed: result.sourceLoadFailed,
    files: await walk(out),
  }, null, 2));
} finally {
  process.chdir(previous);
}
```

Command:

```sh
node /tmp/opencode/region-probe/renderer-probe.mjs
```

The exact emitted tree was:

```text
.claude/agents/builder.md
.claude/commands/probe-command.md
.claude/settings.json
.claude/skills/probe-skill/SKILL.md
.mcp.json
CLAUDE.md
```

The structured files and their top-level keys were:

| Path | Top-level keys observed |
|---|---|
| `.claude/settings.json` | `$schema`, `hooks`, `permissions` |
| `.mcp.json` | `mcpServers` |

The `CLAUDE.md` body was the input rule body, byte for byte, with one trailing newline. The agent
file carried `name`, `description` and `model`. The command and skill files carried their
frontmatter and body.

A second probe ran each feature alone, to see which surface each one creates:

| Feature alone | Files emitted | Keys observed |
|---|---|---|
| `rules` | `CLAUDE.md` | none (plain body) |
| `mcp` | `.mcp.json` | `mcpServers` |
| `hooks` | `.claude/settings.json` | `$schema`, `hooks` |
| `permissions` | `.claude/settings.json` | `$schema`, `permissions` |
| `commands` | `.claude/commands/probe-command.md` | frontmatter `description` |
| `skills` | `.claude/skills/probe-skill/SKILL.md` | frontmatter `name`, `description` |

A third probe carried all five hook phases. `SessionStart`, `SessionEnd`, `PreToolUse`,
`PostToolUse` and `Stop` were all emitted under the `hooks` key, with the matcher preserved on the
two tool events.

### 3.4 What appeared, and the consequence

All three candidate workspace surfaces appeared in the direct renderer probe: `.mcp.json`,
`.claude/settings.json` and `CLAUDE.md`. The instruction file the renderer names for `claudecode`
is `CLAUDE.md` (`CLAUDECODE_RULE_FILE_NAME` in the installed renderer, `rulesync` 43.14.0).

None of the three appeared in the tool's own `generate`, because the tool asks for `subagents`
only (`renderFeatures`, line 170), materialises only `subagents/` for `claudecode`
(`materialiseSourceTree`, line 346), and refuses the workspace kinds at the source boundary
(`assertSupportedRef`, line 351). The consequence is concrete: profile mode on `claudecode` cannot
carry instructions, MCP or hooks unless slice 2 extends the materialiser, the feature list and the
containment gate to author and verify those surfaces. Writing them is feasible with the pinned
renderer; it is not something the current tool path already does.

## 4. The decisions

Each decision is settled. Each records its consequence and the alternative it rejects.

### 4.1 A region is delimited by two marker lines

A managed region in a text file begins with `<!-- farna:begin <region-id> -->` and ends with
`<!-- farna:end <region-id> -->`. HTML comments are valid Markdown and invisible when rendered, so
the markers do not appear in published docs.

**Consequence.** The markers are the only syntax. A region body is the exact bytes between the end
of the begin-marker line and the start of the end-marker line, markers excluded. The body is
replaced as bytes and never parsed or re-wrapped.

**Rejected alternative.** A fenced block or a keyed heading. A fence renders in published docs and
can collide with a user's own code fences; a heading changes the document's outline and is visible
to the reader. An HTML comment is the only delimiter that is both valid Markdown and invisible.

### 4.2 The region id is lower-kebab, stable and recorded

The id matches `ID_RE` (`src/core/constants.ts`, line 304) and the 64-character bound (line 305),
the same grammar as persona and resource ids. It is chosen by the tool, recorded in the lockfile,
and appears in the begin and end marker exactly once per region.

**Consequence.** The id is not taken from the user's file. A marker whose id is not one the plan
knows is a typed refusal, not a region the tool ignores (section 7). The shipped id for the
instruction region is `claude-instructions`.

**Rejected alternative.** Derive the id from the file name or a counter. A file name is not stable
across a rename, and a counter makes the id depend on planning order, so a reordering would look
like a different region.

### 4.3 Ownership is the body, not the file

The lockfile records a `region` entry carrying `path`, `regionId`, and the SHA-256 and byte size of
the body between the markers. `check` compares only that body. Bytes outside the region are the
user's and are never drift. The marker lines themselves are owned by the tool: a missing,
duplicated or malformed marker is never silently repaired.

**Consequence.** The user may edit any byte outside the region without `check` reporting drift. An
edit inside the body is drift. A missing, duplicated or malformed marker is `F001_INVALID_CONFIG`
naming the line, because ownership cannot be determined safely.

**Rejected alternative.** Record the whole file and compare only the region. That makes every
user edit outside the region drift, because the whole-file digest changes, and it records user
content in a lockfile that must stay source-derived.

### 4.4 Behaviour by file state

The seven states and their behaviour:

| State | `generate` | `check` |
|---|---|---|
| the file is absent | create it with the marker pair and the rendered body | the path is missing: `F007_DRIFT`, kind `missing` |
| exactly one well-formed region of the expected id | replace the body, preserving every byte outside it, including a leading BOM | compare the body with the fresh render |
| the file exists without the markers | refuse `F007_DRIFT`, print the exact block to add, and name `generate --adopt` | the region is missing: `F007_DRIFT` |
| `generate --adopt` with an existing unmarked file | append one blank line, the marker pair and the body at the end of the file, then own the region | never adopts |
| a missing region in a recorded file | n/a | `F007_DRIFT`, kind `missing` |
| an unbalanced marker pair (begin without end, end without begin) | `F001_INVALID_CONFIG` naming the line | the same `F001_INVALID_CONFIG` naming the line |
| a duplicate id, a nested region, or an id mismatch | `F001_INVALID_CONFIG` naming the line | the same `F001_INVALID_CONFIG` naming the line |

A file that already has exactly one well-formed region of the expected id but no lockfile entry is
adopted only with `--adopt`, for the same reason an unmarked file is: a marker is not proof that
this tool wrote it. Without `--adopt` it is refused as unrecorded.

**Consequence.** `--adopt` keeps its existing meaning, "take ownership of every existing planned
managed output", and gains the region case: append to an unmarked file, replace the body of a
marked one. A file never in the plan is neither adopted nor removed.

**Rejected alternative.** Modify an unmarked file by default. That would overwrite a file the tool
cannot prove it wrote, which is the exact refusal the whole-file ownership model already makes for
a missing lockfile (`src/cli/commands/generate.ts:lockfileMissing`, line 171).

### 4.5 Line endings and encoding

The file is UTF-8. `init` pins it to LF through `.gitattributes`. A region file whose line endings
are not LF is refused with an action, because rewriting the region in a different line ending would
change the surrounding bytes. A non-UTF-8 file is refused. A leading BOM is preserved.

**Consequence.** `GITATTRIBUTES_LINES` in `src/core/constants.ts` (line 252) gains `/CLAUDE.md text
eol=lf`, plus `/.mcp.json text eol=lf` and `/.claude/settings.json text eol=lf` for the structured
surfaces. `init` merges missing lines into an existing file (`src/cli/commands/init.ts`, line 232),
so an existing repository adds them by re-running `init`. Until then, a CRLF checkout is refused
with the action to convert the file or add the line.

**Rejected alternative.** Normalise a CRLF file on write. Rewriting the file would change bytes
outside the region, which is the one guarantee the primitive exists to make. Refusing is the only
honest answer when the surrounding bytes cannot be preserved.

### 4.6 One owner per file

The region path is claimed by exactly one target. It is added to that target's
`MANAGED_OUTPUT_FILES`, so the existing location-collision guard treats it as a claimed location
and two targets claiming it are refused before any render. Multiple regions of different ids in one
file are allowed only when they are disjoint and owned by the same target. The tool does not
support two targets owning two regions of one file.

**Consequence.** `MANAGED_OUTPUT_FILES.claudecode` becomes `['.mcp.json', '.claude/settings.json',
'CLAUDE.md']` in slice 2. A future target that also claims `CLAUDE.md` is refused by
`assertNoLocationCollisions` with `F005_CONFLICT`, with no target pair named anywhere. A lockfile
may hold two entries with the same `path` and different `regionId`; every recorded-set comparison
is keyed by `(path, regionId)` rather than by path (section 5).

**Rejected alternative.** Allow two targets to own two regions of one file. The lockfile records
ownership by path, orphan removal would have to decide which target's region to remove, and a
target switch could strand one target's region inside a file the other still owns. One owner per
file keeps the existing collision invariant.

### 4.7 Claude Code profile mode

`claudecode` gains profile mode. Exactly one persona is live. On the surfaces the pinned renderer
produces for `claudecode`, the live persona's output is:

- its whole file under `.claude/agents/`;
- `.mcp.json`, with owned key `mcpServers`, when the live persona declares an MCP server;
- `.claude/settings.json`, with owned key `hooks`, when the live persona declares a hook the target
  can carry;
- its instruction text in a `claude-instructions` region of `CLAUDE.md`, when the live persona
  declares at least one rule.

Resources the design does not carry stay refused with the target named. `notLive` and `W109` behave
as they do for the OpenCode targets.

**Consequence.** `PROFILE_TARGETS` gains `claudecode`. The resolver's existing profile-support check
then accepts `active` on it. `assertSupportedRef` narrows: `skill` and `command` stay refused for
`claudecode` in every mode; `mcp` and `hook` are refused in agent mode and accepted in profile
mode, exactly as they are on OpenCode. `renderFeatures` adds `rules`, `mcp` and `hooks` for
`claudecode` when the live persona declares them, and the materialiser authors the corresponding
rulesync source. `expectedPaths` and `verifyRender` gain the three workspace paths. The capability
matrix in `src/matrix/snapshot.ts:claudeCells` (line 179) is updated in the same change that moves
its tests.

**Rejected alternative.** Carry skills and commands too. The renderer emits `.claude/commands` and
`.claude/skills`, but they are whole trees, not a structured file or an instruction region, and
they would widen the change into new managed directories, outside-ownership scanning and two more
capability cells. They are recorded as a later slice instead. This is a deliberate narrowing of the
brief's "any structured workspace file the renderer emits": the two structured files are carried;
the two trees are not.

### 4.8 Rollout is a minor release before 1.0

The lockfile gains a shape and a key, the README and the capability matrix change, and one target
gains a mode. The release is a minor, not a patch. There is no new subcommand; `--adopt` already
exists and gains the region meaning.

**Consequence.** `CHANGELOG.md` names the lockfile addition and the new mode. The README's Status,
Supported targets, Output layout, Profile mode, Capability matrix, What this slice does not do and
Behaviour notes sections are updated in the same pull request as the shipped change. Per the
changelog's rule, before 1.0 a minor release may contain a breaking change and lists it under
**Changed**.

**Rejected alternative.** Ship it in a patch. A lockfile entry shape a reader may want to validate,
a target that accepts a config it used to refuse, and a new `CLAUDE.md` output are exactly what a
reader needs to be told about.

## 5. Data shapes

### The lock entry

A region entry records the body, not the file:

```json
{
  "path": "CLAUDE.md",
  "regionId": "claude-instructions",
  "sha256": "0f7c2f0d6a1c8e9b4a5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3",
  "shape": "region",
  "size": 412
}
```

`sha256` and `size` describe the bytes between the markers. `regionId` is required when `shape` is
`region` and forbidden on every other shape; the `superRefine` in `lockFileEntrySchema` gains that
rule. A region entry with no `regionId`, or a non-region entry with one, is refused by the reader
with `F001_INVALID_CONFIG` naming `.farna/lock.json`.

The `RenderedFile` type in `src/lock/lockfile.ts` gains `regionId`; its existing `shape`,
`ownedSha256` and `ownedSize` carry the region. For a region file, `bytes` is the body to write,
not the whole file. `lockFilesOf` records `ownedSha256` and `ownedSize` for a region exactly as it
does for a structured entry.

### A marked file before and after

Before `generate`:

```markdown
# Team notes

Some user prose.

<!-- farna:begin claude-instructions -->
## House style

An older instruction.
<!-- farna:end claude-instructions -->

More user prose.
```

After `generate`:

```markdown
# Team notes

Some user prose.

<!-- farna:begin claude-instructions -->
## House style

Write the smallest change that satisfies the ticket.
<!-- farna:end claude-instructions -->

More user prose.
```

Every byte outside the two marker lines is unchanged, including the blank lines, the headings, the
BOM if one is present, and the missing final newline if the file had none.

### The marker grammar

```text
marker     = "<!-- farna:" ("begin" | "end") " " region-id " -->"
region-id  = /^[a-z0-9]+(?:-[a-z0-9]+)*$/   (at most 64 characters)
```

A marker is a complete line: the line's content equals the production above exactly, with no
leading or trailing whitespace. A line terminator is LF, or the end of the file for the last line.
A line that contains `<!-- farna:` but does not match the production is `F001_INVALID_CONFIG` naming
the 1-based line number. A file may contain several disjoint regions with different ids; a begin
must have exactly one matching end of the same id, in order, with no other begin between them.

### The file key for recorded-set comparisons

A path alone no longer identifies a recorded file when two disjoint regions can share one path.
Every comparison uses a key:

```text
entryKey(entry) = entry.shape === "region" ? `${entry.path}#region:${entry.regionId}` : entry.path
```

The key is used by `generate`'s expected set (`src/cli/commands/generate.ts`, line 340), by
`check`'s expected set and recorded-set loop (`src/cli/commands/check.ts`, lines 307 and 315), and
by orphan planning. `lockfileTargetOf` stays path-based: one file has one owning target.

## 6. The execution order of one run

The sequence below is a `generate` for a `claudecode` profile run. `check` shares steps 1 to 8 and
compares instead of committing.

1. **Load the config.** `loadConfig` validates `.farna/config.jsonc`. Guarantee: a malformed config
   is `F001` and nothing has been read or written.
2. **Refuse a location collision.** `assertNoLocationCollisions` reads `MANAGED_OUTPUT_DIRS` and
   `MANAGED_OUTPUT_FILES`. Guarantee: two targets claiming `CLAUDE.md` are refused with
   `F005_CONFLICT` (exit 2) before any source is read.
3. **Load the source tree once.** `loadSource` lstat-checks every path. Guarantee: a symlinked
   source path is refused before it is read.
4. **Resolve every target.** `resolveSource` selects profile mode from `active` or `--persona`,
   chooses the live persona, computes `notLive`, and emits `W109` when the live persona declares no
   MCP server or hook. Guarantee: one live persona, or a typed refusal, before any render.
5. **Materialise and render into a disposable stage.** For `claudecode` profile, the materialiser
   writes `subagents/<id>.md`, a root rule carrying the live persona's instruction text, `mcp.jsonc`
   when MCP is declared, and `hooks.jsonc` when a carried hook is declared. `renderFeatures` asks
   for `rules`, `mcp` and `hooks` when those are authored. The renderer emits
   `.claude/agents/<id>.md`, `CLAUDE.md`, and optionally `.mcp.json` and `.claude/settings.json`.
   Guarantee: nothing is written into the repository; the stage is removed in a `finally`.
6. **Verify containment.** `expectedPaths` is derived from the plan, not from the renderer's
   report. The agent file is checked against the persona, the MCP document against the resolved
   servers, the settings document against the resolved hooks, and `CLAUDE.md` against the live
   persona's instruction text. Guarantee: a dropped, invented or altered artefact aborts the run
   with zero writes.
7. **Build the managed file list.** The agent file is whole. `.mcp.json` and `.claude/settings.json`
   are structured entries through `annotateOwnership`. `CLAUDE.md` is a `region` entry whose body
   is the verified `CLAUDE.md` text and whose `regionId` is `claude-instructions`. Guarantee: every
   entry's digest describes exactly what the run claims to own.
8. **Build the lockfile.** `buildLockfile` records the region entry and the structured entries.
   Guarantee: determinism; no timestamp, hostname, absolute path, user name or process id.
9. **Inspect every planned path.** `inspectManagedTarget` refuses a symlink, a directory in the
   way, or a non-regular file. Guarantee: the plan reports only states the write path would accept.
10. **Check ownership.** For a whole or structured path the existing rule applies. For a region
    path: an absent file is fine; a recorded region is fine; an unrecorded existing file is
    `F007_DRIFT` unless `--adopt` was passed. Guarantee: the tool never takes over bytes it cannot
    prove it wrote.
11. **Plan and remove orphans.** A recorded region the plan no longer produces is stripped from the
    file, not deleted: the marker pair and its body are removed, the file is kept when it still
    carries other content, and removed only when nothing but the region remains. Guarantee: only a
    recorded body whose digest still matches is removed, and the user's bytes survive.
12. **Merge into the whole-file bytes.** Structured files are merged in place by owned key. Region
    files are merged by replacing the body between the markers, or by creating the file, or by
    appending on `--adopt`. Guarantee: every byte outside the region is preserved, including a
    leading BOM; a malformed or non-LF file is refused before the merge.
13. **Commit the set atomically.** `commitFiles` receives whole-file bytes for every planned path,
    including the merged region file, and reuses its existing preflight, staging and rename path.
    Guarantee: atomicity per file, restore of already replaced files on a rename failure, and a
    diagnostic naming anything it could not restore. The region's outside bytes are preserved by
    step 12, not by the commit.
14. **Release the lock.** The existing `.farna/.generate.lock` is released in a `finally`.

`check` shares steps 1 to 8 and then:

9. **Compare each planned file.** A whole file is compared by bytes. A structured file is compared
    by its owned keys. A region file is read, decoded, parsed and compared by its body. A missing
    region is `F007_DRIFT` with kind `missing`; a body that differs is `F007_DRIFT` with kind
    `modified`; a malformed, CRLF or non-UTF-8 file is `F001_INVALID_CONFIG` naming the line, because
    ownership cannot be determined safely.
10. **Compare the recorded set.** Every recorded entry is keyed by `(path, regionId)`. A recorded
    region the source no longer produces is drift even when the file remains for another region.
11. **Report.** Per-target mode, live persona, `notLive`, checked paths and drift. `check` never
    writes and never adopts.

## 7. Failure modes and diagnostics

**The file is absent.** `generate` creates it with the marker pair and the body. `check` reports
`F007_DRIFT`, kind `missing`, with the action `run generate`. Nothing outside the new file is
touched.

**The file has exactly one well-formed region.** `generate` replaces the body and nothing else.
`check` compares the body. A leading BOM is preserved; the markers keep their exact bytes.

**The file exists without markers.** `generate` refuses with `F007_DRIFT`, prints the exact block to
add (the begin marker, the body and the end marker), and names `generate --adopt`. Nothing is
written. `check` reports the region as missing. This is the same shape as the missing-lockfile
refusal in `generate.ts:lockfileMissing` (line 171): the tool does not infer ownership from a file
name.

**`generate --adopt` with an existing unmarked file.** One blank line, the marker pair and the body
are appended at the end of the file, and the lockfile records the region. Every existing byte is
kept. A file that is not in the plan is never adopted.

**`check` with a missing region.** `F007_DRIFT`, kind `missing`, detail `the managed region is
missing`. The file itself exists, so the path is not reported as missing.

**A malformed region.** A begin without an end, an end without a begin, a duplicate id, a nested
region, or a marker id the plan does not know is `F001_INVALID_CONFIG` naming the file and the
1-based line. `generate` and `check` both refuse. The file is never repaired, because a repair would
have to guess which bytes were the tool's.

**A duplicate id.** Two begin/end pairs with the same id are the malformed case above, naming the
second begin.

**A nested region.** A begin of one id inside the body of another is the malformed case above,
naming the inner begin.

**A CRLF file.** `F001_INVALID_CONFIG` naming the file and the first line that ends in CR, with the
action `convert the file to LF, or add the .gitattributes entry and re-check it out`. `generate`
does not rewrite the file, because a rewrite would change bytes outside the region.

**A non-UTF-8 file.** `F001_INVALID_CONFIG` naming the file, with the action `save the file as
UTF-8, or move it aside`. `decodeUtf8` already refuses invalid bytes for a structured file, and the
region path uses the same decoder.

**A leading BOM.** Preserved. The parser strips it for line scanning and re-attaches it on write,
the same approach `splitBom` uses in `src/render/structured.ts` (line 36).

**Two regions of the same id.** Refused, as above. Two regions of different ids are accepted only
when they are disjoint and the plan expects both.

**A region in a file another target claims.** Refused at config load by
`assertNoLocationCollisions` with `F005_CONFLICT` (exit 2), naming the path and both target ids.
Nothing is read or written.

**A mid-commit failure.** The merge happens before the commit, so the commit writes whole-file
bytes for every path, including the region file. A failure while staging removes the temporaries
and the directories this run created. A failure between renames restores the files already replaced,
re-reading each target first so a concurrent writer's newer bytes are not overwritten, and names any
file it could not restore (`src/render/commit.ts`, lines 280 to 335). The lockfile still records the
affected paths, so `check` reports the tree accurately and a re-run can finish the job.

**The first `generate` after the upgrade with an existing `CLAUDE.md`.** The region is not yet
recorded, so the run refuses and asks for `generate --adopt`. That is deliberate: the tool cannot
tell a region it wrote in an earlier version from one a user copied. The action is one command.

## 8. Claude Code profile mode

### The output map

The map below is justified by the measurement in section 3. Every surface was observed from the
pinned renderer for `claudecode`; the materialiser, feature list and containment gate are extended
to author and verify it.

| Output | Path | Ownership | Emitted when |
|---|---|---|---|
| live agent | `.claude/agents/<id>.md` | whole file | always |
| MCP servers | `.mcp.json` | structured, key `mcpServers` | the live persona declares an MCP server |
| hooks | `.claude/settings.json` | structured, key `hooks` | the live persona declares a carried hook |
| instructions | `CLAUDE.md` | region `claude-instructions` | the live persona declares at least one rule |

The owned subset of `.claude/settings.json` is `hooks` only. `$schema` and every other key are the
user's and are preserved by the structured merge. The renderer's `permissions` feature also writes
that file, but this design does not author it: the live persona's permission is already carried in
the agent frontmatter as `tools` and `disallowedTools`, and writing it again as a workspace policy
would create two surfaces for one declaration with different scope. The rejected alternative is
authoring the permissions feature and owning `permissions` as well.

### What stays refused

- `skill` and `command` on `claudecode`, in every mode. The renderer can emit `.claude/skills` and
  `.claude/commands`, but they are whole trees, not a structured file or an instruction region, and
  this slice does not add their managed directories. The refusal keeps the target named, as today.
- The workspace `permissions` key in `.claude/settings.json`, for the reason above.
- Any resource kind the renderer does not emit for `claudecode`. None is carried silently; the
  existing source refusal with the target named remains.

### Mode selection, `W109` and `notLive`

`PROFILE_TARGETS` gains `claudecode`, so `targetSupportsProfile` returns true for it and
`resolveSource` accepts `targets.claudecode.active` or `--persona`. The resolver's existing logic is
unchanged: the live persona is the active one, `notLive` is every other resolved persona id sorted
(`src/compose/resolve.ts`, lines 779 to 785), and `W109_PROFILE_BY_CHOICE` is emitted at info
severity when the live persona declares no `mcp` or `hook` (`PROFILE_FORCING_KINDS`,
`src/core/constants.ts`, line 160; the warning is computed at `resolve.ts`, lines 793 to 817). A
profile run forced only by a rule is a choice, and the warning says so.

Two user-visible changes follow. A `claudecode`-only config that passes `--persona` now succeeds
instead of refusing, because the target supports profile mode. On a mixed config, `--persona`
applies to `claudecode` as well, so `W118_PERSONA_FLAG_NOT_APPLIED` is no longer emitted for it
(the flag-ignored path in `src/render/prepare.ts`, line 185, tests `targetSupportsProfile`).

The role of `notLive` is unchanged: it names every resolved persona that is not the live one, so a
deactivated persona is never silent. The lockfile's target entry records `mode: "profile"`,
`activePersona: "<id>"` and `notLive: [...]`, exactly as an OpenCode profile entry does.

### The capability matrix

`claudeCells` in `src/matrix/snapshot.ts` (line 179) currently marks `rule`, `model` and
`permission` as workspace `dropped` with the consequence "profile mode is not supported on
claudecode", and marks `skill`, `command`, `mcp` and `hook` as refused in both modes. In the slice
that ships this design, the cells move to what the tests observe: `rule` workspace becomes native
(the `CLAUDE.md` region), `mcp` workspace becomes native (`.mcp.json`), `hook` workspace becomes
native (`.claude/settings.json`), `skill` and `command` stay dropped with a consequence naming the
later slice, and `model` and `permission` stay workspace dropped with a consequence that says they
are carried per agent and not at the workspace level. The matrix comment already requires a cell to
be edited only in the same change that moves the test observing it, so the golden and real-renderer
tests land with the matrix edit.

## 9. Test plan

The test-file set is pinned in `scripts/expected-test-files.json` and enforced by
`tests/unit/repo-hygiene.test.ts`; the suite count is pinned by `scripts/assert-test-count.mjs`.
Every new file below is a deliberate manifest edit, and no suite is deleted or skipped.

### Unit

- **The marker parser.** A well-formed pair; a begin without an end; an end without a begin; a
  duplicate id; a nested region; an unknown id; a marker with leading whitespace; a line containing
  `<!-- farna:` that is not a marker. Each refusal names the 1-based line. A CRLF file, a non-UTF-8
  file and a BOM file are separate cases; the BOM case proves the mark survives a replace.
- **The body range.** The body is exactly the bytes between the marker lines, including its trailing
  newline; an empty body is two adjacent marker lines.
- **The lock entry.** A region entry requires `regionId` and a body digest; a non-region entry with
  `regionId` is refused; a region entry with no body digest is refused. The existing whole and
  structured entries still validate.
- **The merge.** Replace preserves every byte before the begin marker and after the end marker,
  including a BOM and a missing final newline. Create writes the marker pair and body. Append on
  adopt inserts exactly one blank line. A malformed file is refused before any merge.
- **The file key.** A whole path and a region path produce different keys; two regions in one file
  produce two keys; the recorded-set comparison treats a removed region as drift while the file
  remains for another region.
- **Check and orphan branches.** A region entry is compared by body and not by whole bytes; an
  orphaned region strips the pair and body and keeps the file, and removes the file only when
  nothing else remains.
- **The collision interaction.** `configuredLocationClaims` for `claudecode` includes `CLAUDE.md`,
  `.mcp.json` and `.claude/settings.json`; a synthetic target claiming `CLAUDE.md` is refused.
- **Profile resolution.** `claudecode` accepts `active`, chooses one live persona, computes
  `notLive`, emits `W109` for a rule-only profile and not for an MCP-forced one, and refuses
  `skill` and `command` in profile mode.
- **Feature selection.** `renderFeatures` for `claudecode` profile returns `rules`, `mcp` and
  `hooks` only when the live persona declares them, and still returns only `subagents` in agent
  mode.

### Integration

- **Generate, check, adopt.** On a temporary repository with a `claudecode` target in profile mode:
  generate writes the agent file, `.mcp.json`, `.claude/settings.json` and `CLAUDE.md`; check exits
  0; an edit outside the region still exits 0; an edit inside exits 1; a deleted region exits 1;
  `generate --adopt` on an unmarked `CLAUDE.md` appends and then check exits 0.
- **Byte preservation.** A `CLAUDE.md` with user prose before and after the region, a BOM, and a
  mixed set of newlines around the region is regenerated; every byte outside the region is
  identical to the input.
- **A byte-for-byte golden.** A committed fixture with the four outputs, including a `CLAUDE.md`
  with user content outside the region and user keys in `.mcp.json` and `.claude/settings.json`.
  The golden proves the structured merge keeps the user keys and the region merge keeps the user
  prose.
- **The real renderer.** A test that drives the pinned renderer with the `claudecode` profile
  source and asserts the emitted tree and each top-level key from section 3, so a renderer upgrade
  that changes a surface fails loudly.
- **The collision refusal.** A config with two targets claiming `CLAUDE.md` exits 2 with
  `F005_CONFLICT` and the tree is byte-identical afterwards, including the absence of a lockfile
  when there was none.
- **A mid-commit failure.** The existing mutating-renderer and commit-operation seams prove that a
  failed merge or rename leaves no partial region and that the restore path names what it could not
  restore.

### The test-file manifest

New unit files: `tests/unit/region.test.ts`, `tests/unit/region-lockfile.test.ts`. New integration
files: `tests/integration/region.test.ts`, `tests/integration/claudecode-profile.test.ts`. The
golden fixture lives under `tests/fixtures/` or `tests/golden/` following the existing layout, and
every file is added to `scripts/expected-test-files.json`.

## 10. Delivery slices

Three slices, in order. Each is one pull request. The refactor and the behaviour change stay
separate, as `CONTRIBUTING.md` requires.

### Slice 1: the region primitive and its lock entry

The primitive lands with a fixture target and no mode change. Production `claudecode` still refuses
profile mode and no shipped target emits a region. The exercise is unit and integration tests over
the parser, the merge, the lock entry, `check`, orphan planning and the collision table.

Files: `src/render/region.ts` (new: the marker grammar, the parser, the body range, the merge, the
region id table), `src/lock/lockfile.ts` (the `regionId` field, the schema refinement, the builder
branch), `src/render/prepare.ts` (annotate a region entry), `src/cli/commands/generate.ts` (the
ownership and merge branches, the keyed expected set), `src/cli/commands/check.ts` (the region
comparison, the keyed recorded set), `src/render/orphans.ts` (the region orphan branch),
`src/core/constants.ts` (marker constants), and the unit tests above that do not need profile mode.

Exit criterion: the region parser and merge pass their unit tests; a fixture repository with a
region file generates, checks, adopts and reports drift as specified; a malformed file exits with
`F001` and its line; no shipped target's output changes; every existing golden is unchanged.

### Slice 2: Claude Code profile mode on the measured surfaces

`claudecode` gains profile mode and the four outputs. Files: `src/core/constants.ts`
(`PROFILE_TARGETS`, `MANAGED_OUTPUT_FILES.claudecode`, the gitattributes lines),
`src/compose/resolve.ts` (the narrowed `assertSupportedRef` and the target-aware hook rule),
`src/materialise/source-tree.ts` (author the rule, MCP and hook source for `claudecode` profile;
make the MCP and hook writers target-neutral), `src/verify/containment.ts` (`expectedPaths` and the
new verifiers), `src/render/structured.ts` (the `.mcp.json` and `.claude/settings.json` owned
keys), `src/matrix/snapshot.ts` (the claudecode cells), and the integration, real-renderer and
golden tests.

Exit criterion: a `claudecode` profile config generates and checks the four outputs; an edit
outside the region passes and an edit inside fails; `--persona` works on a claudecode-only config
and on a mixed config; `W109` and `notLive` match the OpenCode behaviour; the capability matrix
matches the tests; the collision guard refuses a second target claiming `CLAUDE.md`.

### Slice 3: documentation and the roadmap

The README describes the region primitive and Claude Code profile mode as shipped: Status,
Supported targets, Output layout, Profile mode, Capability matrix, What this slice does not do and
Behaviour notes. `ROADMAP.md` moves the Later bullet to Shipped. `CHANGELOG.md` carries the minor
release entry and the lockfile note. `docs/multi-target-design.md` keeps its historical scope; this
note is the record for the region change.

Exit criterion: `node dist/cli/main.js check` is clean, every README statement matches the shipped
behaviour, and the changelog names the lockfile addition and the new mode.

## 11. Risks and controls

**A parser bug loses user bytes outside the region.** Control: the merge is a byte-range
replacement, never a re-serialise; the parser refuses any ambiguous file; a golden with user prose
before and after the region, a BOM and no final newline proves preservation.

**A malformed file is repaired wrongly.** Control: a missing, duplicated, nested or mismatched
marker is `F001` naming the line, and the tool never rewrites the marker lines. The user fixes the
file or moves it aside.

**A CRLF or non-UTF-8 checkout corrupts the surrounding bytes.** Control: the file is refused with
an action before any write, and `init` pins it to LF. An existing repository adds the line by
re-running `init`, and the changelog says so.

**A lockfile with a hand-written `region` entry is treated as a whole file.** Control: slice 1
tightens the schema and implements `check` and orphan handling in the same change, so the shape
cannot be recorded without its behaviour. Until slice 1 lands, the reader accepts the shape from a
hand-edited lockfile; the design does not ship that window.

**Two regions in one file break a path-keyed comparison.** Control: every recorded-set comparison
is keyed by `(path, regionId)`, and a unit test covers a removed region in a file another region
still uses.

**The renderer emits a surface the design did not expect.** Control: the real-renderer test asserts
the exact emitted tree and each top-level key for the `claudecode` profile source, so an upgrade
that adds a file or a key fails before the design silently carries it.

**`claudecode` profile mode changes a config that used to be refused.** Control: the minor release
and the changelog name it, the README's Status and Supported targets sections say the mode is
supported, and the behaviour is additive: an agent-mode config is unchanged.

**The capability matrix drifts from the code.** Control: the matrix cell and the test that observes
it move in the same change, as the matrix comment requires.

## 12. No open questions

There are no open questions. Two judgement calls are decided here and recorded so a reader does not
have to reopen them:

1. Skills and commands stay refused on `claudecode` in this design. The renderer can emit their
   trees, but a tree is not a structured file or an instruction region, and adding it would widen
   the change into new managed directories and outside-ownership scanning. A later slice can add
   them with the same measured approach.
2. The workspace `permissions` key in `.claude/settings.json` is not owned. The live persona's
   permission is already carried per agent, and a second workspace copy would apply to a different
   scope. This is a deliberate rejection, not an omission.

If a maintainer wants either judgement reversed, it is a scope change to slice 2, not a blocker for
slice 1: the region primitive and its lock entry do not depend on either answer.
