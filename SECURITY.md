# Security policy

## Supported versions

`farna-bootstrapper` is pre-1.0. Only the latest published release receives fixes; the project does
not maintain security backports for earlier releases.

| Version | Supported |
|---|---|
| the latest published release | yes |
| every earlier release | no |

## Reporting a vulnerability

Do **not** open a public issue, pull request or discussion for a security problem.

Report it privately by email to **security@farnalabs.com** with:

- the affected version (`farna-bootstrapper --version`);
- the operating system and Node.js version;
- a minimal reproduction, or the exact steps and the source tree that triggers it;
- what you observed and what you expected;
- whether the report can be disclosed publicly, and after when.

The maintainers aim to acknowledge a report within five working days and to agree a disclosure
timeline with the reporter. Please give the project a reasonable window to ship a fix before public
disclosure. Credit is offered unless the reporter asks otherwise.

Never include live credentials, tokens or customer data in a report. Use synthetic values. If a
secret may already be exposed, rotate it first and say so in the report; do not send the value.

## Scope

In scope, because these are the properties the product claims:

- **Path handling** — traversal, escaping the repository root, writing through a symlink, or
  following a symlinked source, output or ancestor;
- **Secret handling** — a literal credential in `env`, `headers` or a URL being accepted, echoed in
  a diagnostic, or written into an emitted file; a credential-shaped value being echoed by
  `W115` or `W116`;
- **Ownership and deletion** — removing or overwriting a file the lockfile does not record, or
  deleting outside a managed location;
- **Containment** — a persona's content or permission reaching another persona's artefact, or a
  renderer drop being written rather than refused;
- **Renderer identity** — a renderer other than the pinned version, or a different tarball
  integrity, being accepted;
- **Supply chain** — a production dependency that makes a network call or collects telemetry, or a
  published tarball that contains repository-only files.

Out of scope:

- a vulnerability in `rulesync`, Claude Code, OpenCode or another harness — report it to that
  project (you may also tell us, but the fix belongs upstream);
- anything that requires an attacker to already control the machine, the repository or the
  developer's account;
- findings that only restate a limitation documented in the README's
  [Residual risks and known gaps](README.md#residual-risks-and-known-gaps) — those are known and
  stated, not new vulnerabilities;
- social engineering, physical access and denial of service against a third-party registry.

## What the product does and does not do

`farna-bootstrapper` is a build-time compiler. It makes no network request of its own while
generating or checking, sends no telemetry, has no Farna Control dependency, and never executes a
hook, MCP server or command it writes. A report that shows otherwise is a security report.
