---
kind: rule
id: maintainer-gates
displayName: Maintainer gates
---

Keep one logical change in each pull request. A refactor and a behaviour change
are two pull requests, not one.

A behaviour change carries its test in the same pull request. New output, a new
diagnostic, a new refusal or a changed exit code without a test is not ready.

A user-visible change updates the README in the same pull request. The
quickstart, the capability matrix, the warning and exit-code tables and the
limitations are claims; keep them true.

The renderer pin moves only with a golden diff that shows the byte difference in
the pull request. Never edit a golden file to make a test pass; change the source
and regenerate it with the pinned renderer instead.

Never use `--no-verify`, lower the minimum test count, or delete or disable a
test to get a green run. If a test is genuinely wrong, fix it in place and explain
why in the pull request.

Run the gates from a clean `npm ci` once before you open the pull request. A green
run against a stale `node_modules` is not evidence.

`farna-bootstrapper check` must be green before you report. If you changed
anything under `.farna/`, regenerate the committed agent configuration and commit
it in the same change.

Do not widen `files` in `package.json`. It is an allowlist; `src/`, `tests/`,
`scripts/`, `examples/`, `docs/` and `.github/` never reach the published package.

Do not add a subcommand without a design change. The CLI surface is `init`,
`doctor`, `report`, `generate` and `check`.
