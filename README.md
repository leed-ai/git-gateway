# git-gateway

A git-over-HTTPS gateway for Cloudflare Workers. It puts one URL in front of each repository, authenticates users with credentials you already issue, enforces branch policy at the edge, and gives your services a commit/read/merge API that needs no clone — over Cloudflare Artifacts, GitLab or GitHub storage, swappable without your users noticing.

> Status: in development — the monorepo, toolchain and CI are in place; the packages are being built. See [`docs/design.md`](docs/design.md).

## What it does

- **Smart-HTTP proxy** — `git clone`, `fetch` and `push` against `https://git.example.com/<repo>.git`; bodies are streamed, the storage host is never exposed.
- **Pluggable auth** — bring an authenticator (OAuth/JWT/API key) and an authorizer; git credential helpers can hand over an access token as the password.
- **Branch policy** — per-ref push rules and force-push control, refused in-protocol with a readable message.
- **Service API over Workers RPC** — multi-file commits with GitLab-compatible action semantics, file and tree reads, ref lookups, branch sync by merge, fast-forward promotion.
- **Safe retries** — idempotency keys on every write; inline retries hand off to Cloudflare Workflows.
- **Pluggable storage** — Cloudflare Artifacts first; GitLab and GitHub backends share one contract suite.

## Packages

| Package                                                                | What it is                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`@leed-ai/git-gateway-contract`](packages/contract)                   | Zod schemas and the RPC interface (the API contract), with an in-memory reference implementation.                     |
| [`@leed-ai/git-gateway-core`](packages/core)                           | Platform-free git primitives: pkt-line, receive-pack parsing, object encoding, packs, tree editing, file-level merge. |
| [`@leed-ai/git-gateway-worker`](packages/worker)                       | The gateway Worker: smart-HTTP proxy, auth and policy pipeline, RPC entrypoint, Workflows.                            |
| [`@leed-ai/git-gateway-backend-artifacts`](packages/backend-artifacts) | Storage backend over Cloudflare Artifacts.                                                                            |
| [`@leed-ai/git-gateway-backend-gitlab`](packages/backend-gitlab)       | Storage backend over GitLab.                                                                                          |
| [`@leed-ai/git-gateway-auth-jwt`](packages/auth-jwt)                   | Reference authenticator: JWTs verified against a JWKS (OIDC).                                                         |
| [`@leed-ai/git-gateway-testkit`](packages/testkit)                     | In-memory backend, fixtures, real-git conformance harness and the backend contract suite.                             |
| [`examples/gateway`](examples/gateway)                                 | A deployable Worker showing the composition.                                                                          |

`zod` (`^4.6.0`), `hono` (`^4`) and `cloudflare` (`^5`) are peer dependencies: install them in your application, and every package uses your copy.

## Development

```bash
bun install
bun run verify      # format, lint and type-check (Vite+), test and build every package, repository policy checks
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, the rules the checks enforce, and how releases work. Report security problems privately; see [SECURITY.md](SECURITY.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).
