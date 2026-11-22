# Releasing

How the `@leed-ai/git-gateway-*` packages get to npm, what has to exist before the first publish, and what to do when a publish fails.

There are two parts. **Setup** is done once, by a maintainer who owns the `@leed-ai` npm scope and administers this repository. **Releasing** is what happens after that, and it is one command.

## The shape of it

Every publish comes from one workflow file, `.github/workflows/release.yml`, through **npm trusted publishing (OIDC)**. There is no npm token and no npm secret anywhere: the publishing job mints a short-lived GitHub OIDC token, npm exchanges it for the right to publish, and npm attaches a provenance attestation from the same identity.

| Trigger                                                                   | What it does                                                                                                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push to `main` (every merge)                                              | Opens or updates the Changesets **"chore: release packages"** pull request. Publishes every package as `0.x.y-next.<datetime>` under the `next` dist-tag. |
| `gh workflow run release.yml` (mode `release`, `dry_run` true by default) | Verifies, builds and packs what a release would publish and runs `npm publish --dry-run`. Publishes nothing.                                              |
| `gh workflow run release.yml -f dry_run=false`                            | Publishes the versions on `main` that npm does not have yet under `latest`, then creates a git tag and a GitHub release for each.                         |
| `gh workflow run release.yml -f mode=snapshot [-f dry_run=false]`         | The `next` snapshot, by hand.                                                                                                                             |

Nothing publishes, on any trigger, until the repository variable `NPM_PUBLISHING` is `true`. Until then a push to `main` verifies and packs the snapshot and leaves a notice, and a non-dry-run release fails at its first step and says why.

### Jobs and permissions

| Job               | Runs on                                                | Permissions                                                    | What it runs                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version-pr`      | push to `main`                                         | `contents: write`, `pull-requests: write`                      | `changesets/action` with no publish script: maintains the version PR.                                                                                                                    |
| `pack`            | every run                                              | `contents: read`                                               | Install, `bun run verify`, `bun run test:contract` (in memory), the snapshot versioning for `next`, build, `bun pm pack`, `npm publish --dry-run`. Uploads the tarballs and `plan.json`. |
| `publish`         | `main` only, `NPM_PUBLISHING == 'true'`, not a dry run | `contents: read`, `id-token: write`, environment `npm-publish` | Upgrades npm to 11.5.1 or later, downloads the tarballs and runs `npm publish` for each one. No `bun install`, no build, no tests.                                                       |
| `github-releases` | after a successful `latest` publish                    | `contents: write`                                              | `gh release create` for each published version, with its CHANGELOG section as notes.                                                                                                     |

**The split is the point.** `pack` runs a great deal of third-party code (the install, Vite+, Vitest, tsdown, Wrangler), so it holds nothing worth stealing. `publish` holds the credential that can publish every package, so it runs nothing but npm and two scripts that import Node builtins only (`tooling/repo/test/publish-imports.test.ts` holds that). The workflow policy (`tooling/repo/src/oidc-policy.ts`) fails CI if a job holding `id-token: write` installs dependencies, lacks an environment, or is not limited to this repository's `main`, or if any other workflow uses the `npm-publish` environment.

**The `npm-publish` environment is what pins the ref.** An npm trusted publisher matches the repository and the workflow **filename**; it has no branch field. `workflow_dispatch` runs the workflow file from whichever ref the dispatcher names, so without an environment anyone able to push a branch could run a rewritten `release.yml` from it and publish, with genuine provenance. The environment admits only `main`, and every trusted publisher is registered with `--env npm-publish`, so npm refuses a token minted anywhere else.

**A release publishes what is already on `main`.** Changesets versions the packages in the version PR. Merging it puts the new versions and CHANGELOGs on `main`; the release then publishes exactly those. A real release refuses to start while changesets are still waiting to be versioned, and fails if every version is already on npm.

## Setup, once

Do these in order. The package names are:

```
@leed-ai/git-gateway-auth-jwt
@leed-ai/git-gateway-backend-artifacts
@leed-ai/git-gateway-backend-gitlab
@leed-ai/git-gateway-contract
@leed-ai/git-gateway-core
@leed-ai/git-gateway-testkit
@leed-ai/git-gateway-worker
```

### 0. Prerequisites

- You are an owner of the `leed-ai` npm organization (the scope must match the package names exactly), with **two-factor authentication** on your npm account: `npm trust` refuses without it.
- npm **11.15.0 or later** on your machine (`npm install --global npm@^11.15.0`), for `npm trust`.
- The repository is public. npm generates provenance only for a public repository.
- GitHub Actions may create pull requests: **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**. Without it `version-pr` cannot open the version PR. A PR opened with the workflow's token does not start other workflows, so the required checks on the version PR have to be started by hand (close and reopen it, or push an empty commit to its branch).

### 1. The first publish, from your machine

npm attaches a trusted publisher only to a package that **already exists**, so the first version of every package has to be published some other way. `bun run release:local` is that way: the same build, pack and publish scripts the workflow uses, against your `npm login` session instead of a token.

First merge the "chore: release packages" PR, so `main` carries the first real versions (the packages are `0.0.0` until then, and the script refuses while changesets are waiting). Then, from a clean, current checkout of `main`:

```bash
npm login --auth-type=web          # a session, not a stored token
gh auth status                     # the script creates the GitHub releases with gh
bun run release:local -- --dry-run # build, pack, npm publish --dry-run; changes nothing
bun run release:local              # the same, then type "publish" to publish
```

It refuses to start, listing every reason, when the checkout is not on `main`, has uncommitted changes, is behind `origin/main`, has unversioned changesets, or has no npm or GitHub session. After the confirmation it publishes each package in dependency order with `--provenance=false` (a laptop has no CI identity to sign with, so this first version carries no attestation; every later one does), then creates the git tags and GitHub releases.

**A published version is permanent.** npm allows unpublishing only within 72 hours, and a name and version can never be reused.

### 2. Create the `npm-publish` environment

**Before step 3.** Repository **Settings → Environments → New environment**, named exactly `npm-publish`:

1. **Deployment branches and tags** → _Selected branches and tags_ → add `main`.
2. Optionally, **Required reviewers** → yourself, to make every publish wait for one approval. That includes every `next` snapshot, one per merge, so most setups leave it off.

The environment holds no secrets. The workflow does not run a job in it until step 4, so GitHub never creates it implicitly without the branch rule.

### 3. Attach a trusted publisher to each package

```bash
npm install --global npm@^11.15.0

for pkg in auth-jwt backend-artifacts backend-gitlab contract core testkit worker; do
  npm trust github "@leed-ai/git-gateway-$pkg" \
    --repo leed-ai/git-gateway \
    --file release.yml \
    --env npm-publish \
    --allow-publish \
    --yes
  sleep 2 # the endpoint is rate-limited
done

npm trust list @leed-ai/git-gateway-core # confirm one landed
```

- `--file` is the workflow **file name only**, not a path. It must stay `release.yml`: renaming the workflow stops publishing for every package until each trust is re-pointed.
- `--env npm-publish` is what makes step 2 load-bearing: npm checks the environment claim, so a run from any other ref is refused even though the repository and file name match.
- `--allow-publish` is required: a trust grants nothing without at least one of `--allow-publish` or `--allow-stage-publish`.
- npm does not validate a trust when it is saved. A mistake shows up only at the next publish, as a 404 (see Troubleshooting).

Then, on npmjs.com, set each package's **Settings → Publishing access** to **"Require two-factor authentication and disallow tokens"**. Trusted publishing keeps working, and after that the only thing that can publish these packages is this workflow, from `main`.

### 4. Turn publishing on

```bash
gh variable set NPM_PUBLISHING --repo leed-ai/git-gateway --body true
```

A repository **variable**, not a secret: it holds nothing sensitive and only decides whether the publish job runs. It has to be a repository variable rather than an environment one, because it is read in the job's `if:`, before the job enters the environment. Deleting it (`gh variable delete NPM_PUBLISHING`) turns publishing off again without touching anything else.

From now on, every merge to `main` publishes a `next` snapshot. The first one is the cheapest proof that OIDC works end to end: check its `publish to npm (next)` job, then `npm view @leed-ai/git-gateway-core dist-tags`.

### 5. The first release from CI

When the next version PR has been merged:

```bash
gh workflow run release.yml                  # dry run: what would ship
gh workflow run release.yml -f dry_run=false # ship it
```

Check the run, then the provenance badge on the package page on npmjs.com. That is setup done.

## Releasing, after setup

1. Merge the "chore: release packages" pull request.
2. `gh workflow run release.yml` and read the dry run's summary.
3. `gh workflow run release.yml -f dry_run=false`.

A package added later needs steps 1 and 3 for itself before the first release that carries it: until it exists on npm with a trust attached, every publish of it fails with a 404, and the workflow fails with it.

**A publish is accepted before it is readable.** The registry can show the previous `latest` for several minutes after a successful publish. A completed `npm publish` step in the log is the reliable signal; wait before concluding anything from the registry, and never re-publish on that basis.

## Troubleshooting

**`npm error 404 Not Found - PUT https://registry.npmjs.org/@leed-ai%2fgit-gateway-<name>`** on a CI publish. npm answers 404 rather than 401 when the OIDC exchange gives no publish rights, so this nearly always means the trusted publisher is missing or does not match. Check, in order:

1. The package exists on npm. A brand-new package cannot use OIDC: publish it once with `bun run release:local` (step 1), then attach a trust (step 3).
2. `npm trust list @leed-ai/git-gateway-<name>` shows repository `leed-ai/git-gateway`, file `release.yml` and environment `npm-publish`.
3. The run's `publish` job ran in the `npm-publish` environment, from `main`.
4. The package's `repository.url` in its `package.json` is `git+https://github.com/leed-ai/git-gateway.git`. npm requires it to match the repository exactly (`tooling/repo/test/repository-layout.test.ts` holds every package to it).

Then re-run the failed `publish` job (**Re-run failed jobs**). It reuses the tarballs the `pack` job uploaded and skips every version already on npm, so a partial publish completes rather than duplicating.

**`ENEEDAUTH` / "Unable to authenticate".** The job could not mint an OIDC token, or npm is too old. The publish job needs `id-token: write` and npm 11.5.1 or later; its `Use npm 11.5.1 or later` step prints the version.

**`E422 … Unsupported GitHub Actions source repository visibility: "private"`.** Provenance needs a public repository. Make it public, then start a new run; the claim is fixed when the run is created.

**The release fails at "Decide what this run publishes".** `NPM_PUBLISHING` is not `true` (step 4), or the run was dispatched from a branch other than `main` without `dry_run`.

**The release fails at "Refuse a release with unversioned changesets".** Changesets are waiting. Merge the version PR first.

**The release fails at "Plan" with "Every package is already on npm".** There is nothing new to publish: the version PR has not been merged, or this release already ran.

**`npm trust` refuses.** It needs npm 11.15.0 or later, 2FA on your account, write access to the package, and the package to exist already.

**The version PR never appears.** Check the `version pull request` job. A 403 creating the pull request means the repository does not let GitHub Actions create pull requests (step 0).
