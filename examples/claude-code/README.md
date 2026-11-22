# Claude Code example

Two personas in **agent mode** on the `claudecode` target: every persona is live and each gets one
whole file under `.claude/agents/`.

```
examples/claude-code/
  .farna/
    config.jsonc                       the claudecode target and the standard model
    personas/
      builder.yaml                     writes, tests, follows the house style
      reviewer.yaml                    reviews, cannot modify
    resources/
      rules/
        house-style.md
        review-checklist.md
      permissions/
        builder-default.jsonc          read/write/edit/shell allowed, task denied
        review-only.jsonc              everything mutating denied
```

The reviewer's restriction is real: `review-only` emits `disallowedTools` in
`.claude/agents/reviewer.md`. It is not a sentence in the prompt that the harness could ignore.

## Run it

From the repository root:

```sh
npm ci
npm run build

cd examples/claude-code
node ../../dist/cli/main.js generate
node ../../dist/cli/main.js check
```

Or with the published CLI:

```sh
cd examples/claude-code
npx farna-bootstrapper generate
npx farna-bootstrapper check
```

`generate` writes:

```
.claude/agents/builder.md
.claude/agents/reviewer.md
.farna/lock.json
```

`check` re-renders into a temporary directory and compares. A clean tree exits `0`; editing one
byte of either agent file, or changing a source without regenerating, makes it exit `1` and name the
path.

Inspect the plan without writing:

```sh
node ../../dist/cli/main.js generate --dry-run
node ../../dist/cli/main.js generate --json
```

Start over:

```sh
node ../../dist/cli/main.js generate --adopt   # only needed if you deleted .farna/lock.json
```

## Use it as a starting point

Copy the source tree into your repository, then edit the personas:

```sh
cp -R .farna /path/to/your/repo/
cd /path/to/your/repo
npx farna-bootstrapper generate
npx farna-bootstrapper check
```

The generated output is ignored by this directory's `.gitignore` so the example stays a source
tree. In your own repository, commit `.farna/lock.json` and the generated files.
