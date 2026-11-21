# @leed-ai/git-gateway-testkit

Test kit for git-gateway: in-memory backend, repository fixtures, a real-git conformance harness and the backend contract suite.

Part of [git-gateway](https://github.com/leed-ai/git-gateway). Status: in development; see the [design](https://github.com/leed-ai/git-gateway/blob/main/docs/design.md).

Peer dependencies: `zod` (`^4`), `cloudflare` (`^5`). Install them alongside this package.

## Usage

- `memory/memory-backend` — `MemoryBackend`, a complete `StorageBackend` in memory with a real git smart-HTTP server (`handle(request)`, or `fetch` as a FetchLike). Serve it with `node/serve-fetch-handler` to drive the git binary against it.
- `contract-suite/backend-contract-suite` — `registerBackendContractSuite({ describe, it }, { createBackend, behaviour, fetch? })` registers the backend contract suite with any test framework; every backend runs it unchanged.
- `contract-suite/backend-fixtures` — commits built in memory through the core encoders, for tests that push.
- `git-binary` — locating and versioning the git binary for conformance runs.
- `git-sandbox` — `GitSandbox`, a scratch directory running the git binary isolated from user and system configuration.
- `node/serve-streaming` — `serveStreaming(handler, traffic?)`, a loopback HTTP server that streams request and response bodies under backpressure (as Workers does), so git can drive the gateway and tests can see how much it holds at once.

## License

Apache-2.0
