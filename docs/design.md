# git-gateway — design

Status: draft · License: Apache-2.0

git-gateway is a Cloudflare Worker that sits in front of git repositories and owns every way in: the git smart-HTTP protocol for people and tools, and a typed RPC API for the services that write to the repositories on their behalf. The repositories themselves are never exposed. Storage is a pluggable backend — Cloudflare Artifacts first, with GitLab and GitHub backends so a deployment can move between hosts without its users noticing.

## Why

A service that writes to its customers' repositories usually ends up welded to one host's API: server-side commits through that host's commits endpoint, merges through its merge requests, per-user tokens through its token API, branch protection through its settings. Moving host then means rewriting the service and re-issuing every user's credentials.

git-gateway narrows what a host must provide to what every git host provides — push, fetch, read a file or tree, create and delete a repository — and builds everything else (commits without a clone, merges, branch policy, authentication, idempotent retries) once, in the gateway, on top of that.

## Goals

- **One URL per repository**, owned by the deployment (e.g. `https://git.example.com/<repo>.git`), that keeps working when the storage host changes.
- **Pluggable authentication.** Users authenticate with credentials the deployment already issues (OAuth access tokens, JWTs, API keys). Nobody holds a storage-host token.
- **Branch policy enforced at the edge.** Which principals may push which refs, and whether force pushes are allowed, decided before a push reaches storage.
- **A service API that needs no clone.** Multi-file commits, reads, ref lookups, branch sync and promotion over Workers RPC.
- **Retries that are safe.** Every write is idempotent by key; contention is retried inline and handed to a Workflow when inline retries run out.
- **A test suite thorough enough to trust with production repositories**, run against real `git` clients and every backend.

## Non-goals

- A git hosting UI, issues, merge requests, or CI.
- Line-level merge conflict resolution. Merges are file-level; a file changed on both sides is a conflict reported to the caller.
- SSH transport. HTTPS only.
- Git LFS (may be revisited).

## Architecture

```
            git clients (CLI, IDE, CI)                 services (Workers RPC)
                      │ smart HTTP                              │ service binding
                      ▼                                         ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ gateway Worker                                                            │
 │  authenticate ─► authorize ─► branch policy ─► proxy (streamed)           │
 │  RPC: commit · readFile · listTree · resolveRef · log · commitExists      │
 │       syncBranch · promote · createRepo · deleteRepo · mintReadToken      │
 │  Workflows: CommitWorkflow · SyncBranchWorkflow                           │
 │  push events ─► onPush hooks (e.g. sync staging from main)                │
 └───────────────────────────────┬───────────────────────────────────────────┘
                                 │ StorageBackend
          ┌──────────────────────┼──────────────────────┐
          ▼                      ▼                      ▼
   Cloudflare Artifacts        GitLab                 GitHub
```

### Packages

A Bun + Turborepo monorepo. Every published package is named `@leed-ai/git-gateway-<name>` and lives in `packages/<name>`:

| Package                                  | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@leed-ai/git-gateway-contract`          | **Built first.** The Zod schemas and the RPC interface (the API contract), plus a reference implementation of that interface in memory: commit-action rules, idempotency, reads, `syncBranch` and `promote` (including conflicts), modelled on plain objects rather than git objects. Consumers develop and test against it before the gateway exists; the real gateway is later tested against it as an oracle (same calls, same results).                               |
| `@leed-ai/git-gateway-core`              | Platform-free TypeScript. pkt-line codec, receive-pack command parser, ref advertisements, upload-pack request/response codec, git object encoding (blob/tree/commit), pack writer and reader (OFS/REF deltas, thin packs, a pure-JS zlib inflater that reports where each stream ends), a smart-HTTP client over `fetch`, tree editing, commit-action semantics, file-level three-way merge, idempotency trailers. No Cloudflare imports; runs in Bun, Node and Workers. |
| `@leed-ai/git-gateway-worker`            | The gateway: smart-HTTP proxy, auth and policy pipeline, the RPC `WorkerEntrypoint`, the Workflows, push-event consumer. Configured with backends and hooks; deployments compose it rather than fork it.                                                                                                                                                                                                                                                                  |
| `@leed-ai/git-gateway-backend-artifacts` | `StorageBackend` over the Artifacts binding (repo lifecycle, tokens, reads) and its git remotes (push/fetch).                                                                                                                                                                                                                                                                                                                                                             |
| `@leed-ai/git-gateway-backend-gitlab`    | `StorageBackend` over a GitLab instance: git over HTTPS plus the repository files/tree/projects APIs for reads and lifecycle.                                                                                                                                                                                                                                                                                                                                             |
| `@leed-ai/git-gateway-backend-github`    | Later. Same contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `@leed-ai/git-gateway-auth-jwt`          | Reference authenticator: bearer/Basic-password JWT verified against a JWKS (OIDC).                                                                                                                                                                                                                                                                                                                                                                                        |
| `@leed-ai/git-gateway-testkit`           | In-memory backend, repository fixtures, a harness that drives the real `git` binary against a running gateway, and the backend contract suite.                                                                                                                                                                                                                                                                                                                            |
| `examples/gateway`                       | A deployable Worker with `wrangler.jsonc`, showing the composition.                                                                                                                                                                                                                                                                                                                                                                                                       |

Two private workspaces support the packages and are never published: `tooling/schema-docs` (the schema-documentation test harness, below) and `tooling/repo` (the dependency-policy, SPDX and workflow checks, the shared Vite+ presets and the release scripts).

Each module is its own package export (`@leed-ai/git-gateway-worker/health`), with named exports only and no barrel files. Exports carry a `source` condition pointing at the TypeScript source, which type checking uses so it never waits for a build; everything else resolves to `dist/`.

### Dependencies

Three libraries are the foundation, and each is a **peer dependency** declared by supported major range (`^`), never pinned to an exact version, so the host application controls the version and there is one copy of each in the bundle:

| Peer                | Used for                                                                                                                                                                                                                                                                                                                                                                | Declared by                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `zod` (`^4`)        | **Every data structure**: RPC inputs and outputs, commit actions, configuration, push-event payloads, backend responses, policy rules, errors. Types are `z.infer` of the schema; nothing crossing a boundary is trusted until it is parsed.                                                                                                                            | every package                  |
| `hono` (`^4`)       | Routing in the Worker: the smart-HTTP endpoints, health, and any HTTP surface; auth and policy run as Hono middleware.                                                                                                                                                                                                                                                  | `worker`, `examples/gateway`   |
| `cloudflare` (`^5`) | **All Cloudflare REST API calls** (the official SDK): Artifacts control plane outside a binding (namespaces, repos, tokens), Workers Builds, Queues event subscriptions. Where the SDK has no typed resource yet, its generic request methods (`client.get`/`client.post`) are used — never hand-rolled `fetch` to `api.cloudflare.com`. Responses are parsed with Zod. | `backend-artifacts`, `testkit` |

**Every Zod schema is self-documenting.** The schemas are the documentation, so each one is fully described:

- Every schema, every object field, every enum member and every union branch carries a description through Zod 4 metadata — `.meta({ id, title, description, examples })` on named schemas, `.describe()` at minimum on fields. A description says what the value means, its units and format (e.g. "40-character lowercase hex SHA-1"), its constraints and defaults, and when it is absent.
- Enum members are described with an `enumDescriptions` map in the enum's metadata (`.meta({ description, enumDescriptions: { read: "…", write: "…" } })`), which also appears in the generated JSON Schema; a union of described literals works too.
- Constraints live in the schema, not in prose alone: lengths, regexes for SHAs and ref names, integer ranges, `.default()` values, discriminated unions for action kinds and error codes.
- Named schemas are registered in one registry (`z.globalRegistry` or a package registry) with stable ids, and the reference docs and the published JSON Schema for the RPC API and configuration are generated from it with `z.toJSONSchema` — never written by hand.
- A test walks every exported schema (including nested fields) and fails the build if any node lacks a description or a named schema lacks an id and an example; the generated JSON Schema is snapshot-tested, so a change to a contract shows up in review. The walker is `tooling/schema-docs`; every package runs it from `test/schema-docs.test.ts` over its own `src/` modules. Exported schemas must be named, ids must be unique, and every example must parse against its schema.

The policy is enforced in CI: `tooling/repo/src/peer-policy.ts` holds the three ranges, and `bun run policy` fails if any package lists a peer under `dependencies`, declares a peer by anything but its policy range, imports a peer from shipped source without declaring it, or pins any dependency to an exact version. The library build (tsdown via `vp pack`) keeps the peers, `cloudflare:*` and `node:*` imports external.

`peerDependenciesMeta` marks a peer optional where only part of a package needs it. Each package's dev dependencies install the latest peers so CI tests against current versions, and a nightly CI leg tests against the lowest version in each declared range.

Inside a Worker, bindings (`env.ARTIFACTS`, Workflows, Queues) are preferred over REST; the SDK covers what bindings do not.

### Storage backend contract

The interface and its schemas live in `@leed-ai/git-gateway-contract/storage/*`; backends import them from there and define no parallel types.

```ts
interface StorageBackend {
  // lifecycle
  createRepo(name: RepoName, options?: { defaultBranch?: BranchName }): Promise<StorageRepoInfo>; // repo_exists if taken
  deleteRepo(name: RepoName): Promise<void>; // missing repo: no-op
  repoInfo(name: RepoName): Promise<StorageRepoInfo | null>;

  // reads (no clone)
  resolveRef(repo: RepoName, ref: StorageRef): Promise<Sha | null>; // "main" = refs/heads/main; refs/tags/… too
  readCommit(repo: RepoName, sha: Sha): Promise<Commit | null>;
  readTree(repo: RepoName, sha: Sha): Promise<StorageTreeEntry[] | null>; // one level, stored order
  readBlob(repo: RepoName, sha: Sha): Promise<Uint8Array | null>;
  readFile(repo: RepoName, ref: Revision, path: FilePath): Promise<Uint8Array | null>;
  log(repo: RepoName, ref: Revision, opts: { limit: number; offset?: number }): Promise<Commit[]>; // first-parent chain, newest first

  // transport
  gitRemote(repo: RepoName, access: 'read' | 'write'): Promise<GitRemote>; // { url, headers, expiresAt }
}
```

`StorageRepoInfo` is `{ name, defaultBranch, createdAt }` (no host URL or credential); `StorageTreeEntry` is a contract `TreeEntry` without its path (a tree read by id cannot know it); `GitRemote` carries the smart-HTTP URL, the headers that authorize it (the short-lived credential) and when it expires.

Conventions, pinned by the contract suite: inputs are parsed with the contract schemas (`invalid_input` before the host is called); every call on a missing repository is `repo_not_found` except `repoInfo` (null) and `deleteRepo` (no-op); a missing object, ref, path, or an id of the wrong kind is `null` (`[]` for `log`), never an error; a host failure is `storage_unavailable`. Every host response is parsed with Zod before it leaves the backend.

Writes go through the git transport (`git-receive-pack`) using `gitRemote(..., "write")`; a backend never needs a commits API. Backends with richer read APIs may implement reads natively; others can fall back to a fetch.

- **Artifacts** (`ArtifactsBackend`): the Workers binding for lifecycle, tokens (one scoped, short-lived token per `gitRemote` call; the token `create` returns is revoked at once) and reads. Artifacts has no ref API, so `resolveRef` reads the head of `log`. The binding strips one trailing newline from commit messages and drops time zones; the exact message is recovered by re-encoding the commit and matching its id. Outside a Worker, `ArtifactsRestControl` covers namespaces, repositories and tokens through the official `cloudflare` SDK (generic `client.get`/`post`/`delete`, Zod-parsed envelopes).
- **GitLab** (`GitLabBackend`): each repository is a private project in one group. Lifecycle, refs, blobs, files and history use REST API v4; commits and trees are read as git objects over smart HTTP (`want <id>`, `deepen 1`, `filter tree:0`/`tree:1`), because the API reports neither tree ids nor raw messages. GitLab access tokens are not scoped per request, so read and write remotes carry the same credential; branch policy at the gateway decides who may push. Deleting a project also removes it permanently when the instance uses delayed deletion, so the name is free again.
- **In-memory** (`MemoryBackend`, testkit): the full contract plus a real protocol v0/v1 smart-HTTP server (upload-pack with shallow and partial-clone filters, receive-pack with thin packs, atomic pushes and git's ref-lock semantics), so the git binary and the gateway can push and fetch against it.

### Commits without a clone

`commit()` builds new objects from only what it needs:

1. Resolve the branch head (or use the caller's `expectedHead`).
2. Read the trees along each changed path (`readTree`), never the whole snapshot.
3. Apply the actions, write new blobs and trees, and a commit whose parent is the head.
4. Push a pack of just the new objects in one `git-receive-pack` request whose update command names the old head. A stale head is refused by the server; nothing is overwritten.
5. On refusal, re-resolve and rebuild (inline retries, bounded); if retries run out, start a `CommitWorkflow` with the same idempotency key and return its instance id.

Action semantics match the GitLab Commits API that most existing integrations already speak, so callers can migrate without behavioural surprises:

| Action   | Behaviour                                                            |
| -------- | -------------------------------------------------------------------- |
| `create` | Fails if the path exists.                                            |
| `update` | Fails if the path does not exist.                                    |
| `upsert` | Creates or replaces (convenience; not in GitLab).                    |
| `delete` | Fails if the path does not exist.                                    |
| `move`   | `previousPath` must exist and `path` must not; optional new content. |
| `chmod`  | Sets or clears the executable bit (`executeFilemode`).               |

Content is UTF-8 text or base64. A commit with no effective change is reported as `noop` and pushes nothing. Author, committer and message are the caller's; the gateway appends a `Gateway-Idempotency-Key:` trailer.

**Idempotency.** Before writing, `commit()` looks back through the branch's recent history (bounded by count and time) for a commit carrying the same key. If found, it returns that commit instead of writing another. A retried Workflow step, or a caller retrying after a timeout, can never commit twice.

### Branch sync and promotion

- **`syncBranch({ from, into })`** brings `into` up to date with `from` without rewriting `into`:
  - `into` contains `from` → nothing to do.
  - `into` has no commits of its own → fast-forward (a ref update naming the old head).
  - both have commits → a merge commit built by file-level three-way merge against the merge base. A path changed on only one side takes that side; a path changed differently on both sides is a conflict and the sync fails with the list of paths. Nothing is force-pushed.
- **`promote({ from, into, sha })`** fast-forwards `into` to `sha` only if `sha` is the current head of `from` and contains the head of `into`. It never merges and never forces.
- **`onPush` hooks** let a deployment run sync automatically, e.g. "after any push to `main`, sync `main` into `staging`", as a `SyncBranchWorkflow` with retries.

### Smart-HTTP proxy

Routed with Hono; authentication, authorization and branch policy are Hono middleware. Endpoints: `GET /<repo>.git/info/refs?service=git-upload-pack|git-receive-pack`, `POST /<repo>.git/git-upload-pack`, `POST /<repo>.git/git-receive-pack`.

- Request and response bodies are **streamed**, never buffered. For pushes, only the leading pkt-line update commands are parsed (old sha, new sha, ref) before the stream is forwarded.
- Policy failures are reported in-protocol (`ERR` / `ng <ref> <reason>`) so `git` prints a readable message.
- Protocol v2 is passed through for fetch; push uses v1 receive-pack (which every client supports).
- The upstream credential is minted per request from the backend and never reaches the client.

### Authentication and authorization

```ts
interface Authenticator {
  authenticate(req: Request): Promise<Principal | null>; // null → 401 with WWW-Authenticate: Basic
}
interface Authorizer {
  authorize(p: Principal, repo: string, op: 'read' | 'write'): Promise<boolean>;
}
interface BranchPolicy {
  check(p: Principal, repo: string, updates: RefUpdate[]): PolicyResult; // per-ref allow/deny + reason
}
```

- git sends credentials as HTTP Basic; the password is treated as a bearer credential, so a credential helper can return an OAuth access token.
- Decisions may be cached briefly per principal and repository (configurable, default 60 s).
- The RPC API is reachable only over a service binding; it carries the calling service's identity, not a user's.
- An audit hook receives every authenticated operation (principal, repo, op, refs, outcome).

## Testing

The suite is the product's main safety argument; it runs on every PR.

**Unit (`core`)** — pkt-line round-trips, receive-pack command parsing (including capabilities, push options, malformed input), object hashing against `git hash-object` fixtures, pack encoding verified by `git index-pack`, tree editing, every commit-action rule above, idempotency lookup.

**Property tests** (fast-check) — three-way merge: commutativity of non-conflicting changes, conflicts exactly when both sides change a path differently, merge result never loses a one-sided change; tree edits preserve untouched entries byte-for-byte.

**Conformance with real git** (`testkit` harness, `git` binary, several git versions in CI) — modelled on git's own HTTP transport tests (`t5551-http-fetch-smart`, `t5541-http-push-smart`, `t5516-fetch-push`, `t5537-fetch-shallow`):

- clone, fetch, shallow clone and deepen, protocol v0/v1/v2 negotiation
- push new branch, delete branch, fast-forward, rejected non-fast-forward, force push allowed/denied by policy, push to a protected ref denied with a readable message
- concurrent pushes to the same ref: exactly one wins, the other is refused
- credential helper flow: 401 → helper → retry; expired credential
- large and binary files, executable bit, deep trees, empty repository, unicode paths

**Backend contract suite** (`@leed-ai/git-gateway-testkit/contract-suite/backend-contract-suite`) — one suite, registered unchanged against each backend, which declares only how its host treats non-fast-forward pushes and whether a read remote can push. It covers lifecycle, every read, transport (push and fetch through the backend's own remote with the core smart-HTTP client), stale-head and stale-delete refusal, create-over-existing refusal, non-fast-forward behaviour, branch and tag create/delete, concurrent pushes (exactly one wins), empty repositories, wrong-kind reads, unicode paths, all byte values, deep trees and large binary files. It runs on every PR against the in-memory backend, the Artifacts local simulator (Workers Vitest, real git remotes on loopback) and the GitLab backend over a fake GitLab built on the in-memory backend; against a disposable GitLab project when `GITLAB_CONTRACT_TOKEN` is set (main and nightly).

**Worker tests** (`@cloudflare/vitest-plugin`, in workerd) — auth pipeline, policy, RPC, Workflows (inline retry → workflow hand-off, idempotent replay), push-event hooks.

**Reference review.** The gitbeaker client's unit tests were reviewed; they assert request shapes only, so behaviour is specified from GitLab's Commits API documentation and from the operations integrations actually perform, and pinned by the contract suite.

Coverage gate: 90 % lines on `core`, 80 % elsewhere; mutation testing (Stryker) on `core` nightly.

## Tooling

- **Bun** for install, scripts and the test harness.
- **Turborepo** for the task graph and caching: `build`, `check`, `test`, `test:conformance` and `test:contract` per package; tests depend on upstream builds.
- **Vite+** (`vp check`): Oxfmt formatting, Oxlint linting with type-aware rules, and type checking through tsrs (the Rust port of the TypeScript 7 compiler, via `tsrs-lint`) — one pass over the whole repository. Lint and format settings live in the root `vite.config.ts`.
- **Vitest 5** (via `vp test`). Worker packages (`worker`, `backend-artifacts`, `examples/gateway`) run their tests inside workerd through `@cloudflare/vitest-plugin`, the renamed successor of `@cloudflare/vitest-pool-workers` (which stopped at Vitest 4).
- **tsdown** (Rolldown, via `vp pack`) for library builds: one ESM entry per module with declaration files, `zod`, `hono` and `cloudflare` kept external (peers); Wrangler builds the example Worker (`wrangler deploy --dry-run`).
- **fast-check** for property tests.

## CI and releases (GitHub Actions)

Third-party actions are pinned to commit SHAs, every workflow declares its permissions, and no job that holds a secret can run for a pull request; `tooling/repo/src/workflow-policy.ts` checks all three in CI.

- `check` — one `vp check` pass over the repository (seconds), the dependency-policy, SPDX and workflow checks, actionlint, and `turbo run build` (affected packages only on a PR). The example Worker is built, never deployed.
- `test` — Turbo runs the affected packages' tests on a PR (everything on `main`), each package's Vitest files split across a shard matrix (`--shard=<i>/<n>`, where `n` is the matrix size, so changing the shard count is one line), Turbo cache restored from the Actions cache. A `tests passed` job gives branch protection one check that does not change with the shard count.
- `conformance` — the real-git harness (`*.conformance.test.ts`) across a git-version matrix: 2.34, 2.39, 2.43, 2.51, 2.56 built from source (cached) and the runner's own git.
- `contract` — backend contract suite. The in-memory leg runs on every PR; the GitLab and live-Artifacts legs run on `main`, nightly and on dispatch in `leed-ai/git-gateway` with secrets from the `contract` environment, never on pull requests or forks, and skip with a notice while their secrets are unset.
- `release` — Changesets: version PR, then npm publish with provenance. Packages are packed with `bun pm pack` (which resolves `workspace:` ranges) and published with `npm publish --provenance`. Without an `NPM_TOKEN` secret only the version PR is maintained.
- `snapshot` — every merge to `main` publishes all packages to npm under the `next` dist-tag (`0.x.y-next.<datetime>`, with provenance), so consumers' CI can run against the latest gateway before a release. Consumers move to a real release version before they ship. Without `NPM_TOKEN` it builds the versions and publishes nothing.
- `nightly` — the whole suite against the lowest version in each peer range (`zod` 4.0.0, `hono` 4.0.0, `cloudflare` 5.0.0) and against the latest, without the Turbo cache.
- CodeQL (JavaScript/TypeScript and Actions), Dependabot (Bun and Actions, weekly), and `SECURITY.md` for private vulnerability reports.

Branch protection on `main` requires `check`, `build`, `tests passed`, `conformance passed`, `contract (in-memory)` and CodeQL.

## Developing consumers in parallel

The contract is frozen before the gateway logic is written, so a consumer can be built alongside it:

- Code against the RPC types from `@leed-ai/git-gateway-contract`; test against its in-memory reference implementation.
- Locally, `bun link` the packages (or install a `bun pm pack` tarball). Because `zod`, `hono` and `cloudflare` are peers, the linked packages use the consumer's own copies — one Zod instance, no duplicate-schema surprises.
- In Workers tests, run the gateway Worker as an auxiliary worker behind a service binding, over the in-memory backend, so the consumer's suite exercises real gateway code rather than a mock.
- In CI, depend on the `next` snapshots; never commit a link or `file:` dependency.

Changing a published contract schema after consumers depend on it is a breaking change and goes through a Changeset.

## Open questions

1. ~~Does the Artifacts server refuse a receive-pack update whose old sha is stale, and how does it treat non-fast-forward updates without force?~~ **Answered** (`packages/backend-artifacts/test/open-question-1.test.ts`, and the contract suite's push-semantics cases, against the Artifacts local simulator): a stale old id is refused in-protocol with `ng <ref> failed to update ref` and the ref is left alone; creating a ref that exists (old id all zeros) is refused the same way. A non-fast-forward update whose old id is current is **accepted** — Artifacts behaves like git's receive-pack without `receive.denyNonFastForwards`. "Force" never reaches the server: git's client refuses a non-fast-forward before pushing unless forced, so the server sees only old and new ids. The gateway therefore cannot rely on the host to refuse non-fast-forwards; branch policy at the edge must, and `commit()`/`syncBranch`/`promote` stay safe because every update names the head they built on. The live contract leg repeats the check against the deployed service.
2. Can Cloudflare Workers Builds be connected to an Artifacts repository programmatically and started manually for a given branch and commit, with a separate Worker per branch? If not, builds clone through the gateway with a short-lived read token.
3. Memory ceiling for `commit()` on very wide trees; streaming pack construction if needed.
