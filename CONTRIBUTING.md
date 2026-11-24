# Contributing

Thanks for taking a look. This is a small, deliberately narrow project: one package, one command
surface, three targets. The fastest way to get a change accepted is to keep it inside that shape and
to bring a test with it.

## Requirements

- **Node.js 22.22.0 or newer** (the `rulesync` floor, and what `engines.node` promises). Older
  Node versions are not supported and CI does not test them.
- **npm**. The build uses npm, `tsc` and Vitest. Do not add a second package manager, a workspace
  or a bundler step.
- No Docker, no database, no service. The real-renderer suites run from an ordinary `npm ci`.

## Set up

```sh
git clone https://github.com/farnalabs/farna-bootstrapper.git
cd farna-bootstrapper
npm ci
npm run build
node dist/cli/main.js --version
```

`npm ci` runs the package's `prepare` script, which builds `dist/`. `dist/` is gitignored and is
never committed.

## The gates

Run every gate before opening a pull request. A change is not ready while any of these is red.

```sh
npm run lint
npm run typecheck
npm test -- --reporter=default --reporter=json --outputFile=vitest-report.json
node scripts/assert-test-count.mjs vitest-report.json
npm run build
npm audit --audit-level=moderate
node scripts/assert-pack.mjs
npm pack --dry-run
npm publish --dry-run
```

What each gate is for:

| Gate | What it protects |
|---|---|
| `lint` | formatting and the repository's lint rules (Biome) |
| `typecheck` | `src/` **and** `tests/` under the full strict configuration |
| `test` | the suites, including the real pinned renderer and the golden bytes |
| `assert-test-count` | no suite silently deleted, skipped, left as `todo`, or failing to collect |
| `build` | the published `dist/` entry points |
| `audit` | no known moderate-or-worse advisory in the dependency tree |
| `assert-pack` | `prepack` built the entry points, and every tarball path is on the allowlist (`dist/` plus the legal files), with no source map |
| `pack` / `publish-check` | the exact package npm will publish, without publishing it |

Do not use `--no-verify`, lower the minimum test count, or delete or disable a test to get a green
run. If a test is genuinely wrong, fix it in place and explain why in the pull request.

### Adding a test file

The test-file set is pinned in `scripts/expected-test-files.json`, and
`tests/unit/repo-hygiene.test.ts` requires the manifest to equal the files on disk. Adding a suite
is therefore a deliberate edit to that manifest; a memory of having added a test is not enough.

## The renderer pin

`rulesync` is pinned to exactly `43.12.0` with a tarball integrity, and **the emitted bytes are the
product**. Two rules follow:

1. **One importer.** `src/render/upstream.ts` is the only module allowed to import `rulesync`
   (including a type-only `import('rulesync')` reference). Every other module talks to the
   `RenderTarget` port in `src/render/port.ts`; `src/cli/main.ts` is the only place that binds the
   real implementation. A fake renderer is what makes the negative gates testable.
2. **The pin moves only with a golden diff.** A version or integrity change re-renders
   `tests/golden/` and must show the byte difference in the pull request. Do not edit a golden file
   to make a test pass; change the source and regenerate it with the pinned renderer.

If you need a renderer behaviour the port does not expose, say so in the pull request before
threading a new field through. A silent widening of the seam is a design change, not a fix.

## Where a change belongs

This repository's README is the user-facing contract and the record of the behaviour it covers. If a
behaviour is not explained there, open an issue and ask rather than inferring it from a generated
file; a change that silently invents product behaviour will be declined.

## Pull request expectations

- One logical change per pull request. A refactor and a behaviour change are two pull requests.
- **A behaviour change carries its test in the same pull request.** New output, a new diagnostic, a
  new refusal or a changed exit code without a test is not ready.
- **A user-visible change updates the README in the same pull request.** The quickstart, the
  capability matrix, the warning and exit-code tables and the limitations are claims; keep them
  true. A docs-only edit is still a change: verify the statement against the code, do not assume it.
- **Keep `files` an allowlist.** `src/`, `tests/`, `scripts/`, `examples/`, `docs/` and `.github/`
  never reach the published package. `scripts/assert-pack.mjs` fails the build if one does.
- **No new subcommand without a design change.** The CLI surface is `init`, `doctor`, `report`,
  `generate` and `check`. `run`, `use`, `list`, `fetch` and the like are deliberately absent (see
  the README's [What this slice does not do](README.md#what-this-slice-does-not-do)).
- **Exactly one target per run.** A change that renders several targets in one invocation needs a
  per-target lockfile and mode plan; propose it as a design change first.
- **No change to a golden byte without explaining which source change moved it.**
- **A change under `.farna/` re-runs `generate` and commits the regenerated files.** The
  repository's own `.claude/agents/maintainer.md` and `.farna/lock.json` are committed output;
  `farna-bootstrapper check` runs in CI and fails on drift.
- Before opening the pull request, run the gates above from a clean `npm ci` once. A green run
  against a stale `node_modules` is not evidence.

## Releasing

This section is for maintainers. A release is cut from `main` and published by pushing a tag; nobody
publishes from a laptop.

1. Update `version` in `package.json` and add the entry to `CHANGELOG.md` in a normal pull request.
   `PRODUCT_VERSION` in `src/core/constants.ts` must equal the manifest version (a test asserts it).
   If the release changes behaviour the README states, update the README in the same pull request.
2. Merge the pull request and wait for CI on `main` to pass.
3. Create and push an annotated tag whose name is `v` plus that exact version:

   ```sh
   git tag -a v0.1.1 -m "v0.1.1"
   git push origin v0.1.1
   ```

   `.github/workflows/release.yml` runs on `v*` tags. Its `verify` job checks out full history,
   refuses a tag that does not match `package.json` or whose commit is not an ancestor of
   `origin/main`, runs the full gate list, and uploads the exact tarball `npm pack` produced. Its
   `publish` job names the `release` environment, so it waits for the required reviewers before the
   npm token is available, then publishes that tarball with npm provenance and creates the GitHub
   Release.
4. Approve the `release` environment when the publish job asks.

The environment secret **`release.NPM_TOKEN`** is required (Settings > Environments > release >
Environment secrets). It is an npm automation token with publish rights for `farna-bootstrapper`.
The GitHub Release uses the workflow's own `GITHUB_TOKEN`. Provenance is generated from the
workflow's OIDC identity, so no additional signing secret is stored.

The dist-tag is derived by the workflow, never typed: `1.2.3` publishes to `latest` and
`1.2.3-beta.1` publishes to `next`; a version that is neither fails the run before publishing.
Re-running a partially failed release is safe: an npm version that already exists is skipped, and
the GitHub Release is created only when it is absent.

Before tagging, `npm run pack`, `npm run publish-check` and `npm run assert-pack` must all exit `0`
locally. After the first successful publish of a version, verify that the README quickstart
(`npx farna-bootstrapper --version`, then `init`, `generate` and `check`) works against the
published package. If a release must be withdrawn, unpublish or deprecate the npm version
deliberately and record why in the changelog; never re-tag a published version.

## No telemetry, no phone-home, no secrets

- **No telemetry and no phone-home.** Do not add an analytics package, an endpoint constant, a
  background request, a crash reporter or a "usage ping". The product is self-contained: no
  Farnalabs-operated service, and no Farna Control dependency at build time or run time.
- **No network client in `src/`.** Generation and checking are offline. A dependency that phones
  home is a release blocker, not a preference.
- **No secrets in the repository.** Never commit a token, key, credential or customer value, and do
  not paste one into an issue or a pull request. Source files declare credentials as environment
  references (`{ "fromEnv": "NAME" }`), never literals; a literal is refused (`F002`) and never
  echoed.
- Report a security issue privately, per [SECURITY.md](SECURITY.md). Do not open a public issue
  for it.

## Commits

Short imperative subject lines, for example `fix: refuse a symlinked output ancestor` or
`docs: describe the profile-mode invariant`. Include the reason in the body when the change is not
obvious. Do not mix formatting-only churn into a behavioural commit.

## Licence

By contributing you agree that your contribution is licensed under the MIT License in
[LICENSE](LICENSE). Third-party notices are in [NOTICE](NOTICE).
