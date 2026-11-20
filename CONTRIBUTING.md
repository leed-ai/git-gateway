# Contributing to git-gateway

Thanks for helping. git-gateway sits in front of people's repositories, so the bar is correctness first: every change comes with tests, and the suite runs against real `git` clients and every storage backend.

## Setup

You need [Bun](https://bun.sh) (the version in `package.json` → `packageManager`), Node.js 24 (`.node-version`) and git 2.34 or newer.

```bash
bun install
bun run verify        # check, test and build every package, then the repository policy checks
```

## Layout

| Path                  | What it is                                                                          |
| --------------------- | ----------------------------------------------------------------------------------- |
| `packages/*`          | The published packages, `@leed-ai/git-gateway-<name>`.                              |
| `examples/gateway`    | A deployable Worker showing the composition. Built in CI, never deployed from here. |
| `tooling/schema-docs` | The schema-documentation test harness every package runs. Private.                  |
| `tooling/repo`        | Repository checks and release scripts. Private.                                     |

## Everyday commands

| Command                           | What it does                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `bunx vp check`                   | Format check (Oxfmt), lint (Oxlint, type-aware) and type check, over the whole repository. `bunx vp check --fix` fixes what it can. |
| `bun run policy`                  | Dependency policy, SPDX header and workflow policy checks.                                                                          |
| `bunx turbo run test`             | Every package's tests. Add `--filter=@leed-ai/git-gateway-core` for one package, or `--affected` for what your branch touches.      |
| `bunx turbo run test:conformance` | The real-git conformance suite. `GIT_BINARY=/path/to/git` picks the binary.                                                         |
| `bunx turbo run build`            | Library builds (tsdown via `vp pack`) and the example Worker (`wrangler deploy --dry-run`).                                         |

## Rules the checks enforce

- **Peers, not dependencies.** `zod` (`^4`), `hono` (`^4`) and `cloudflare` (`^5`) are peer dependencies declared by their major range, also listed as dev dependencies so tests run against the latest. Nothing in the repository is pinned to an exact version. `tooling/repo/src/peer-policy.ts` holds the ranges.
- **Every Zod schema documents itself.** Each exported schema is named with `.meta({ id, title, description, examples })`; every field, enum member (`enumDescriptions`) and union branch has a description that says what the value means, its format and units, constraints, default and when it is absent. Constraints live in the schema. Each package's `test/schema-docs.test.ts` fails on any gap and snapshots the generated JSON Schema, so contract changes show in review.
- **Named exports, no barrels.** No default exports (except tool configs and the example Worker's entry), no `index.ts` that only re-exports. Each module is its own package export.
- **Small files.** 300 lines at most.
- **SPDX headers.** Every source file starts with `// SPDX-License-Identifier: Apache-2.0`.

## Tests

- Unit and property tests (fast-check) sit in each package's `test/` directory.
- Packages that run inside Workers (`worker`, `backend-artifacts`, `examples/gateway`) run their tests in workerd through `@cloudflare/vitest-plugin`.
- Real-git tests are named `*.conformance.test.ts` and run in the `conformance` workflow across a git-version matrix.
- Backend contract tests run as `test:contract`; the GitLab and live-Artifacts legs need secrets and run only on `main` and nightly.

## Pull requests

1. Branch from `main`.
2. Add a changeset for any change to a published package: `bun run changeset`.
3. Make sure `bun run verify` passes.
4. Open the PR; fill in the template.

CI runs `check`, `test`, `conformance`, `contract` (in-memory leg) and CodeQL on every PR, forks included. No job that holds a secret runs for a pull request.

## Releases

Maintainers merge the Changesets release PR to publish to npm with provenance. Every merge to `main` also publishes all packages under the `next` dist-tag. Both are inert until the repository has an `NPM_TOKEN` secret.

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
