# Capability matrix

This page is generated from the committed capability snapshot by
`node scripts/capability-page.mjs`. It states what this build emits and verifies for each measured
target, not what a harness does at runtime.

Evidence basis: every measured cell names the test that observes it. `basis` is
`emitted` for a golden test that pins the emitted bytes and `probe` for a planner test that
proves a refusal. The harness remains the authority on runtime behaviour.

`unknown` is never a tick. A cell marked `[?]` was not measured, and an id in the not-measured
list below carries no capability claim at all.

Generated from farna-bootstrapper 0.2.0 against renderer rulesync 43.14.0, matrix schema version 1.

## Emissions

| Value | Glyph | Meaning |
|---|---|---|
| native | `[x]` | the harness carries the capability in its own form |
| emulated | `[~]` | the capability is carried by a different mechanism, or with a widening |
| dropped | `[ ]` | the capability is not carried; the consequence names the refusal or warning |
| not measured | `[?]` | the capability was never measured, so it is never presented as a tick |

Each cell has two axes: `agent` (one persona's artefact) and `workspace` (visible to every
persona).

## Measured targets

| Target | Status | Reach | rule | model | permission | skill | command | mcp | hook | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| `claudecode` | promised | subagent | [x] / [x] | [x] / [ ] | [x] / [ ] | [ ] / [ ] | [ ] / [ ] | [ ] / [x] | [ ] / [x] | `tests/golden/builder-python.test.ts`, `tests/golden/claudecode-profile.test.ts`, `tests/unit/loader.test.ts` |
| `opencode` | promised | primary | [x] / [x] | [x] / [x] | [x] / [x] | [ ] / [x] | [ ] / [x] | [ ] / [x] | [ ] / [x] | `tests/golden/opencode.test.ts`, `tests/unit/profile-mode.test.ts` |
| `opencodev1` | promised | primary | [x] / [x] | [x] / [x] | [x] / [x] | [ ] / [x] | [ ] / [x] | [ ] / [x] | [ ] / [x] | `tests/golden/opencode-v1.test.ts`, `tests/unit/opencode-v1-target.test.ts` |

Each capability cell reads `agent / workspace`: whether the capability can land in one persona's
artefact, and whether it can land at the workspace level where every persona sees it.

### `claudecode`

| Capability | agent | workspace | basis | Test | Consequence |
|---|---|---|---|---|---|
| `rule` | [x] native | [x] native | emitted | `tests/golden/claudecode-profile.test.ts` | - |
| `model` | [x] native | [ ] dropped | emitted | `tests/golden/builder-python.test.ts` | Claude Code carries a model per agent, so it is written in the agent file and not at the workspace level |
| `permission` | [x] native | [ ] dropped | emitted | `tests/golden/builder-python.test.ts` | Claude Code carries a permission per agent, so it is written in the agent file and not at the workspace level |
| `skill` | [ ] dropped | [ ] dropped | probe | `tests/unit/loader.test.ts` | claudecode does not carry skills; a persona that references one is refused with F001 in every mode, because it is a whole tree and carrying it is a later slice |
| `command` | [ ] dropped | [ ] dropped | probe | `tests/unit/loader.test.ts` | claudecode does not carry commands; a persona that references one is refused with F001 in every mode, because it is a whole tree and carrying it is a later slice |
| `mcp` | [ ] dropped | [x] native | emitted | `tests/golden/claudecode-profile.test.ts` | claudecode configures MCP servers at the workspace level in .mcp.json, not per agent, so an agent mode persona loses its server; profile mode carries it |
| `hook` | [ ] dropped | [x] native | emitted | `tests/golden/claudecode-profile.test.ts` | claudecode carries hooks at the workspace level in .claude/settings.json, so an agent mode persona loses its hook (W101, high); profile mode carries every phase except a matcher on stop |

### `opencode`

| Capability | agent | workspace | basis | Test | Consequence |
|---|---|---|---|---|---|
| `rule` | [x] native | [x] native | emitted | `tests/golden/opencode.test.ts` | - |
| `model` | [x] native | [x] native | emitted | `tests/golden/opencode.test.ts` | - |
| `permission` | [x] native | [x] native | emitted | `tests/golden/opencode.test.ts` | - |
| `skill` | [ ] dropped | [x] native | emitted | `tests/unit/profile-mode.test.ts` | skills are workspace level only on opencode, so an agent mode persona loses this skill; profile mode carries it |
| `command` | [ ] dropped | [x] native | emitted | `tests/unit/profile-mode.test.ts` | commands are workspace level only on opencode, so an agent mode persona loses its command set; profile mode carries it |
| `mcp` | [ ] dropped | [x] native | emitted | `tests/unit/profile-mode.test.ts` | opencode configures MCP servers at the workspace level, not per agent, so an agent mode persona loses its server; profile mode carries it |
| `hook` | [ ] dropped | [x] native | emitted | `tests/unit/profile-mode.test.ts` | opencode carries hooks at the workspace level only, as a generated plugin, so an agent mode persona loses its hook (W101, high); profile mode carries representable events only |

### `opencodev1`

| Capability | agent | workspace | basis | Test | Consequence |
|---|---|---|---|---|---|
| `rule` | [x] native | [x] native | emitted | `tests/golden/opencode-v1.test.ts` | - |
| `model` | [x] native | [x] native | emitted | `tests/golden/opencode-v1.test.ts` | - |
| `permission` | [x] native | [x] native | emitted | `tests/golden/opencode-v1.test.ts` | - |
| `skill` | [ ] dropped | [x] native | emitted | `tests/unit/opencode-v1-target.test.ts` | skills are workspace level only on opencodev1, so an agent mode persona loses this skill; profile mode carries it |
| `command` | [ ] dropped | [x] native | emitted | `tests/unit/opencode-v1-target.test.ts` | commands are workspace level only on opencodev1, so an agent mode persona loses its command set; profile mode carries it |
| `mcp` | [ ] dropped | [x] native | emitted | `tests/unit/opencode-v1-target.test.ts` | opencodev1 configures MCP servers at the workspace level, not per agent, so an agent mode persona loses its server; profile mode carries it |
| `hook` | [ ] dropped | [x] native | emitted | `tests/unit/opencode-v1-target.test.ts` | opencodev1 carries hooks at the workspace level only, as a generated plugin, so an agent mode persona loses its hook (W101, high); profile mode carries representable events only |

## Permission keys

Per persona, agent mode.

| Target | `read` | `write` | `edit` | `shell` | `network` | `mcp` | `task` |
|---|---|---|---|---|---|---|---|
| `claudecode` | [x] | [x] | [x] | [x] | [ ] (F011_PERMISSION_UNMAPPED) | [ ] (F011_PERMISSION_UNMAPPED) | [x] |
| `opencode` | [x] | [~] (W112_PERMISSION_LOSSY) | [x] | [x] | [ ] (F011_PERMISSION_UNMAPPED) | [?] (F011_PERMISSION_UNMAPPED) | [x] |
| `opencodev1` | [x] | [~] (W112_PERMISSION_LOSSY) | [x] | [x] | [ ] (F011_PERMISSION_UNMAPPED) | [?] (F011_PERMISSION_UNMAPPED) | [x] |

### `claudecode`

| Key | Emission | Code | Test | Consequence |
|---|---|---|---|---|
| `read` | [x] native | - | `tests/unit/permissions.test.ts` | - |
| `write` | [x] native | - | `tests/unit/permissions.test.ts` | - |
| `edit` | [x] native | - | `tests/unit/permissions.test.ts` | - |
| `shell` | [x] native | - | `tests/unit/permissions.test.ts` | - |
| `network` | [ ] dropped | `F011_PERMISSION_UNMAPPED` | `tests/unit/permissions.test.ts` | Claude Code has no tool for a bare network category; a declaration is refused with F011 |
| `mcp` | [ ] dropped | `F011_PERMISSION_UNMAPPED` | `tests/unit/permissions.test.ts` | a bare mcp category names no tool; a declaration is refused with F011 |
| `task` | [x] native | - | `tests/unit/permissions.test.ts` | - |

### `opencode`

| Key | Emission | Code | Test | Consequence |
|---|---|---|---|---|
| `read` | [x] native | - | `tests/unit/opencode-target.test.ts` | - |
| `write` | [~] emulated | `W112_PERMISSION_LOSSY` | `tests/unit/opencode-target.test.ts` | opencode has no write category, so write is emitted as edit; an allow also permits modifying existing files |
| `edit` | [x] native | - | `tests/unit/opencode-target.test.ts` | - |
| `shell` | [x] native | - | `tests/unit/opencode-target.test.ts` | - |
| `network` | [ ] dropped | `F011_PERMISSION_UNMAPPED` | `tests/unit/permissions.test.ts` | opencode has no mapping for a bare network category; a declaration is refused with F011 |
| `mcp` | [?] not measured | `F011_PERMISSION_UNMAPPED` | `tests/unit/permissions.test.ts` | opencode's bare mcp permission category is not measured in this release; a declaration is refused with F011 |
| `task` | [x] native | - | `tests/unit/opencode-target.test.ts` | - |

### `opencodev1`

| Key | Emission | Code | Test | Consequence |
|---|---|---|---|---|
| `read` | [x] native | - | `tests/unit/opencode-v1-target.test.ts` | - |
| `write` | [~] emulated | `W112_PERMISSION_LOSSY` | `tests/unit/opencode-v1-target.test.ts` | opencodev1 has no write category, so write is emitted as edit; an allow also permits modifying existing files |
| `edit` | [x] native | - | `tests/unit/opencode-v1-target.test.ts` | - |
| `shell` | [x] native | - | `tests/unit/opencode-v1-target.test.ts` | - |
| `network` | [ ] dropped | `F011_PERMISSION_UNMAPPED` | `tests/unit/opencode-v1-target.test.ts` | opencodev1 has no mapping for a bare network category; a declaration is refused with F011 |
| `mcp` | [?] not measured | `F011_PERMISSION_UNMAPPED` | `tests/unit/permissions.test.ts` | opencodev1's bare mcp permission category is not measured in this release; a declaration is refused with F011 |
| `task` | [x] native | - | `tests/unit/opencode-v1-target.test.ts` | - |

## Evidence

The test ids above are repository-relative paths. A cell is edited only in the same change
that moves the test observing it, so a cell with no test would be a claim nobody measured.
Every id above is listed in `scripts/expected-test-files.json`. The page cannot state a claim
that `report` does not print, and CI runs
`node scripts/capability-page.mjs --check` so a stale page cannot merge.

## Not measured

This list names the renderer's 68 target ids that have no measured row, out of the
71 ids the pinned renderer accepts. It makes no capability claim: the
renderer accepting an id is not evidence that this build renders, verifies or describes
anything for it. One harness can have several ids (for example `opencode` and `opencodev1`),
so this is a count of ids, not a count of harnesses.

- `agentsmd`
- `agentsskills`
- `aiassistant`
- `amp`
- `androidstudio`
- `antigravity-cli`
- `antigravity-ide`
- `antigravity-plugin`
- `augmentcode`
- `augmentcode-legacy`
- `augmentcode-plugin`
- `bob`
- `claudecode-legacy`
- `claudecode-plugin`
- `cline`
- `codebuddy`
- `codebuff`
- `codewhale`
- `codexcli`
- `commandcode`
- `continue`
- `copilot`
- `copilotcli`
- `cortexcode`
- `crush`
- `cursor`
- `deepagents`
- `devin`
- `devin-plugin`
- `dsh`
- `factorydroid`
- `firebender`
- `gitlabduo`
- `goose`
- `grokcli`
- `hermesagent`
- `junie`
- `kilo`
- `kimi-code`
- `kimi-code-plugin`
- `kiro`
- `kiro-cli`
- `kiro-ide`
- `lettacode`
- `mimocode`
- `musecode`
- `omp`
- `openclaw`
- `pi`
- `pool`
- `qoder`
- `qwencode`
- `reasonix`
- `replit`
- `roo`
- `rovodev`
- `tabnine`
- `takt`
- `trae`
- `vibe`
- `vibe-plugin`
- `warp`
- `warpcli`
- `xum`
- `zcode`
- `zcode-plugin`
- `zed`
- `zoocode`

---

Regenerate this page with `npm run build` and `node scripts/capability-page.mjs`. CI runs
`node scripts/capability-page.mjs --check` and fails when the committed page is stale.
