# Contributing to Multi

Start with the [README](README.md) for usage and the [architecture](ARCHITECTURE.md)
for provider execution and permission boundaries. [AGENTS.md](AGENTS.md) contains
our code map, development rules, and full verification guide.

## Local setup

Use Node.js **24.12 or newer** and npm.

```sh
git clone https://github.com/greenpolo/cc-multi-cli-plugin.git
cd cc-multi-cli-plugin
npm ci
npm run check
```

The checks cover banner freshness, formatting and lint, unused code, strict
TypeScript, and offline tests. They do not require provider logins or paid inference.

## Making a change

1. Create a branch and keep the change focused on one problem.
2. Add or update meaningful unit tests for behavior changes. Documentation-only
   changes do not need new tests.
3. Update usage docs and `CHANGELOG.md` when behavior visible to users changes.
4. Run `npm run check` before opening a pull request.

Use `npm run format` for formatting and `npm run lint:fix` for safe lint fixes.
If changing the banner, edit `scripts/banner.mjs` and run `npm run banner:generate`.

Changes to live integrations also need the relevant opt-in checks listed in
[AGENTS.md](AGENTS.md#verification). These use real accounts and may spend provider
usage. Keep probes bounded; Cursor checks must explicitly disable Fast mode.
Describe checks you could not run and why in the pull request.

For Claude Mods hook or surface changes, also run `npm run test:mod` with the
installed Claude Code executable. It runs local plugin tests without provider
inference and is not included in `npm run check` or the current CI matrix.

## Reporting problems

Use the [bug report form](https://github.com/greenpolo/cc-multi-cli-plugin/issues/new?template=bug_report.yml)
and include the provider, model or worker, permission mode, platform, versions,
and a small reproduction. Remove credentials and private task content from logs.
Use the [feature request form](https://github.com/greenpolo/cc-multi-cli-plugin/issues/new?template=feature_request.yml)
for proposals, including the task the change would enable.

## Pull requests

Explain the problem, resulting behavior, and validation. Call out changes to
permissions, credential handling, native state, or platform support so reviewers
can assess their effects. Follow the repository's existing patterns and preserve
provider isolation.
