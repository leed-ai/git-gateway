# git-gateway

A git-over-HTTPS gateway for Cloudflare Workers. It puts one URL in front of each repository, authenticates users with credentials you already issue, enforces branch policy at the edge, and gives your services a commit/read/merge API that needs no clone — over Cloudflare Artifacts, GitLab or GitHub storage, swappable without your users noticing.

> Status: design. See [`docs/design.md`](docs/design.md).

## What it does

- **Smart-HTTP proxy** — `git clone`, `fetch` and `push` against `https://git.example.com/<repo>.git`; bodies are streamed, the storage host is never exposed.
- **Pluggable auth** — bring an authenticator (OAuth/JWT/API key) and an authorizer; git credential helpers can hand over an access token as the password.
- **Branch policy** — per-ref push rules and force-push control, refused in-protocol with a readable message.
- **Service API over Workers RPC** — multi-file commits with GitLab-compatible action semantics, file and tree reads, ref lookups, branch sync by merge, fast-forward promotion.
- **Safe retries** — idempotency keys on every write; inline retries hand off to Cloudflare Workflows.
- **Pluggable storage** — Cloudflare Artifacts first; GitLab and GitHub backends share one contract suite.

## License

Apache-2.0 — see [LICENSE](LICENSE).
