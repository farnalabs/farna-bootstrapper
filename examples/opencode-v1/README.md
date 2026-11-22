# OpenCode 1.x profile example

One live persona in **profile mode** on the `opencodev1` target, which writes for **OpenCode 1.x**
(package `opencode-ai`, current 1.19.6). OpenCode carries MCP servers, skills, commands and hooks
at the workspace level, so a persona that declares one needs the whole workspace. That is what
profile mode is: exactly one persona is live and owns it.

```
examples/opencode-v1/
  .farna/
    config.jsonc                       opencodev1, active: builder
    personas/
      builder.yaml                     the live persona
      reviewer.yaml                    resolved, validated, not live
    resources/
      rules/
        house-style.md
        review-checklist.md
      permissions/
        builder-default.jsonc
        review-only.jsonc
      mcp/docs.jsonc                   an HTTP server; the token is an env reference
      skills/release-check/SKILL.md
      commands/run-tests.md
      hooks/session-start.jsonc
```

`builder` declares `mcp`, `skill`, `command` and `hook`. The MCP server and the hook are boundary
capabilities OpenCode carries only at the workspace level, so profile mode is **required**, not a
choice. `reviewer` is still resolved and validated, but it is not live, and every run reports that
(`notLive`) rather than leaving it silent.

## Run it

From the repository root:

```sh
npm ci
npm run build

cd examples/opencode-v1
node ../../dist/cli/main.js generate
node ../../dist/cli/main.js check
```

Or with the published CLI:

```sh
cd examples/opencode-v1
npx farna-bootstrapper generate
npx farna-bootstrapper check
```

`generate` writes OpenCode 1.x shapes, at the same paths the 2.x target uses:

```
opencode.jsonc                            the owned `mcp` key, merged in place
                                          (a flat `mcp.<name>` map, with `enabled: true`)
.opencode/agents/builder.md               the live persona only, with V1 frontmatter:
                                          `name`, `description`, `mode`, `model`,
                                          and the per-tool `permission` map
.opencode/skills/release-check/SKILL.md
.opencode/commands/run-tests.md
.opencode/plugins/rulesync-hooks.js       the V1 `RulesyncHooksPlugin` module
.farna/lock.json
```

`reviewer` gets no file: profile mode is one persona per workspace. The run prints the personas
that are not live, and `--json` carries them as `notLive`.

Because `opencode.jsonc` is structured, it is safe to keep your own keys in it. The tool owns only
`mcp`; a `theme`, a `$schema` or a comment of yours is preserved, and editing it is not drift.

To see a different persona own the workspace for one run:

```sh
node ../../dist/cli/main.js generate --persona reviewer
node ../../dist/cli/main.js check --persona reviewer
```

`--persona` wins over `targets.opencodev1.active` and is not written back to the config. Selecting
profile mode when nothing forces it is reported as `W109_PROFILE_BY_CHOICE` (info), not an error.

## Check the plan without writing

```sh
node ../../dist/cli/main.js generate --dry-run
node ../../dist/cli/main.js generate --json
```

## Use it as a starting point

Copy the source tree into your repository, then edit the persona and its resources:

```sh
cp -R .farna /path/to/your/repo/
cd /path/to/your/repo
npx farna-bootstrapper generate
npx farna-bootstrapper check
```

The generated output is ignored by this directory's `.gitignore` so the example stays a source
tree. In your own repository, commit `.farna/lock.json` and the generated files.

If you want agent mode instead, remove `mcp/docs`, `skill/release-check`, `command/run-tests` and
`hook/session-start` from `builder` and delete `active` from the config. All four kinds are
workspace-only on OpenCode, so agent mode refuses a reference to any of them (F001) rather than
dropping it; with only rules and permissions left, both personas become live and no workspace file
is written.

For OpenCode 2.x (`@opencode/cli`), see [`examples/opencode-v2/`](../opencode-v2/). Both OpenCode
targets write the same paths in each major's own shapes, so switching is one config edit and does
not orphan the recorded output.
