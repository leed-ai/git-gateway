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

A Bun + Turborepo monorepo:

| Package | Contents |
|---|---|
| `@git-gateway/core` | Platform-free TypeScript. pkt-line codec, receive-pack command parser, git object encoding (blob/tree/commit), pack writer, tree editing, commit-action semantics, file-level three-way merge, idempotency trailers. No Cloudflare imports; runs in Bun, Node and Workers. |
| `@git-gateway/worker` | The gateway: smart-HTTP proxy, auth and policy pipeline, the RPC `WorkerEntrypoint`, the Workflows, push-event consumer. Configured with backends and hooks; deployments compose it rather than fork it. |
| `@git-gateway/backend-artifacts` | `StorageBackend` over the Artifacts binding (repo lifecycle, tokens, reads) and its git remotes (push/fetch). |
| `@git-gateway/backend-gitlab` | `StorageBackend` over a GitLab instance: git over HTTPS plus the repository files/tree/projects APIs for reads and lifecycle. |
| `@git-gateway/backend-github` | Later. Same contract. |
| `@git-gateway/auth-jwt` | Reference authenticator: bearer/Basic-password JWT verified against a JWKS (OIDC). |
| `@git-gateway/testkit` | In-memory backend, repository fixtures, a harness that drives the real `git` binary against a running gateway, and the backend contract suite. |
| `examples/gateway` | A deployable Worker with `wrangler.jsonc`, showing the composition. |

### Dependencies

Three libraries are the foundation, and each is a **peer dependency** declared by supported major range (`^`), never pinned to an exact version, so the host application controls the version and there is one copy of each in the bundle:

| Peer | Used for | Declared by |
|---|---|---|
| `zod` (`^4`) | **Every data structure**: RPC inputs and outputs, commit actions, configuration, push-event payloads, backend responses, policy rules, errors. Types are `z.infer` of the schema; nothing crossing a boundary is trusted until it is parsed. | every package |
| `hono` (`^4`) | Routing in the Worker: the smart-HTTP endpoints, health, and any HTTP surface; auth and policy run as Hono middleware. | `worker`, `examples/gateway` |
| `cloudflare` (`^5`) | **All Cloudflare REST API calls** (the official SDK): Artifacts control plane outside a binding (namespaces, repos, tokens), Workers Builds, Queues event subscriptions. Where the SDK has no typed resource yet, its generic request methods (`client.get`/`client.post`) are used — never hand-rolled `fetch` to `api.cloudflare.com`. Responses are parsed with Zod. | `backend-artifacts`, `testkit` |

`peerDependenciesMeta` marks a peer optional where only part of a package needs it. Each package's dev dependencies install the latest peers so CI tests against current versions, and a nightly CI leg tests against the lowest version in each declared range.

Inside a Worker, bindings (`env.ARTIFACTS`, Workflows, Queues) are preferred over REST; the SDK covers what bindings do not.

### Storage backend contract

```ts
interface StorageBackend {
  // lifecycle
  createRepo(name: string, opts: { defaultBranch: string }): Promise<RepoInfo>;
  deleteRepo(name: string): Promise<void>;
  repoInfo(name: string): Promise<RepoInfo | null>;

  // reads (no clone)
  resolveRef(repo: string, ref: string): Promise<Sha | null>;
  readCommit(repo: string, sha: Sha): Promise<Commit | null>;
  readTree(repo: string, sha: Sha): Promise<TreeEntry[] | null>;   // one level
  readBlob(repo: string, sha: Sha): Promise<Uint8Array | null>;
  readFile(repo: string, ref: string, path: string): Promise<Uint8Array | null>;
  log(repo: string, ref: string, opts: { limit: number; offset?: number }): Promise<Commit[]>;

  // transport
  gitRemote(repo: string, access: "read" | "write"): Promise<{ url: string; headers: Headers }>;
}
```

The types above are sketches; each (`RepoInfo`, `Commit`, `TreeEntry`, `Sha`, …) is defined as a Zod schema and exported alongside its inferred type, and every backend parses what its host returns before handing it back.

Writes go through the git transport (`git-receive-pack`) using `gitRemote(..., "write")`; a backend never needs a commits API. Backends with richer read APIs may implement reads natively; others can fall back to a fetch.

### Commits without a clone

`commit()` builds new objects from only what it needs:

1. Resolve the branch head (or use the caller's `expectedHead`).
2. Read the trees along each changed path (`readTree`), never the whole snapshot.
3. Apply the actions, write new blobs and trees, and a commit whose parent is the head.
4. Push a pack of just the new objects in one `git-receive-pack` request whose update command names the old head. A stale head is refused by the server; nothing is overwritten.
5. On refusal, re-resolve and rebuild (inline retries, bounded); if retries run out, start a `CommitWorkflow` with the same idempotency key and return its instance id.

Action semantics match the GitLab Commits API that most existing integrations already speak, so callers can migrate without behavioural surprises:

| Action | Behaviour |
|---|---|
| `create` | Fails if the path exists. |
| `update` | Fails if the path does not exist. |
| `upsert` | Creates or replaces (convenience; not in GitLab). |
| `delete` | Fails if the path does not exist. |
| `move` | `previousPath` must exist and `path` must not; optional new content. |
| `chmod` | Sets or clears the executable bit (`executeFilemode`). |

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
  authenticate(req: Request): Promise<Principal | null>;   // null → 401 with WWW-Authenticate: Basic
}
interface Authorizer {
  authorize(p: Principal, repo: string, op: "read" | "write"): Promise<boolean>;
}
interface BranchPolicy {
  check(p: Principal, repo: string, updates: RefUpdate[]): PolicyResult;  // per-ref allow/deny + reason
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

**Backend contract suite** — one suite, run unchanged against the in-memory backend, the Artifacts local binding (Workers Vitest), and a disposable GitLab project; covers lifecycle, every read, transport, and the documented edge cases (stale-head push refused, force-push behaviour, ref deletion).

**Worker tests** (`@cloudflare/vitest-pool-workers`) — auth pipeline, policy, RPC, Workflows (inline retry → workflow hand-off, idempotent replay), push-event hooks.

**Reference review.** The gitbeaker client's unit tests were reviewed; they assert request shapes only, so behaviour is specified from GitLab's Commits API documentation and from the operations integrations actually perform, and pinned by the contract suite.

Coverage gate: 90 % lines on `core`, 80 % elsewhere; mutation testing (Stryker) on `core` nightly.

## Tooling

- **Bun** for install, scripts and the test harness.
- **Turborepo** for the task graph and caching.
- **Vite+** (`vp check`): Oxfmt formatting, Oxlint linting with type-aware rules, and type checking through tsgolint on the TypeScript 7 native compiler — one pass.
- **Vitest** (via Vite+) with the Workers pool for Worker packages.
- **tsdown** (Rolldown) for library builds, with `zod`, `hono` and `cloudflare` kept external (peers); Wrangler for the Worker.

## CI and releases (GitHub Actions)

- `check` — `vp check` on the affected graph.
- `test` — Turbo affected packages, Vitest sharded across a matrix that grows with the suite (`--shard i/n`), Turbo cache restored from the Actions cache.
- `conformance` — real-git harness across a git-version matrix.
- `contract` — backend contract suite; the GitLab and live-Artifacts legs run on `main` and nightly with repository secrets, never on forks.
- `release` — Changesets: version PR, then npm publish with provenance; the example Worker is built, not deployed.
- CodeQL, dependency updates, and `SECURITY.md` for private vulnerability reports.

## Open questions

1. Does the Artifacts server refuse a receive-pack update whose old sha is stale, and how does it treat non-fast-forward updates without force? (Pinned by the contract suite before anything depends on it.)
2. Can Cloudflare Workers Builds be connected to an Artifacts repository programmatically and started manually for a given branch and commit, with a separate Worker per branch? If not, builds clone through the gateway with a short-lived read token.
3. Memory ceiling for `commit()` on very wide trees; streaming pack construction if needed.
