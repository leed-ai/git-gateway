# @leed-ai/git-gateway-worker

## 0.1.1

### Patch Changes

- Updated dependencies [[`b24d579`](https://github.com/leed-ai/git-gateway/commit/b24d5794077ba417f96ad253ec27c2e624829deb)]:
  - @leed-ai/git-gateway-contract@0.1.1
  - @leed-ai/git-gateway-core@0.1.1

## 0.1.0

### Minor Changes

- [#1](https://github.com/leed-ai/git-gateway/pull/1) [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe) Thanks [@kingmesal](https://github.com/kingmesal)! - `SmartHttpConfig.deniedStatus` (`'err'`, the default, or `403`) chooses how the smart-HTTP proxy answers an authorization refusal: in-protocol with an `ERR` packet as before, or HTTP 403 with the reason as a plain-text body, which git reports as "The requested URL returned error: 403". Branch-policy refusals stay in-protocol either way.

- [#11](https://github.com/leed-ai/git-gateway/pull/11) [`16bcfd1`](https://github.com/leed-ai/git-gateway/commit/16bcfd1f7539cbbcfdf74cc0968de477527064c2) Thanks [@kingmesal](https://github.com/kingmesal)! - An optional `PushPolicy` hook (`GatewayAppOptions.pushPolicy`) runs after the branch policy on every push and can refuse updates in-protocol for what they change. `needs()` decides per push whether `check()` gets changed paths: the commits each update brings with every `ChangedPath` (path, change, modes, ids, size), computed from the pushed pack and storage within new bounds (`SmartHttpConfig.maxPushPolicyPackBytes`, `maxPushPolicyObjectBytes`, `maxPushPolicyReads`, `maxChangedPaths`); a push that cannot be checked within them is refused. New schemas: `ChangedPath`, `PushedCommit`, `PushPolicyUpdate`, `PushPolicyInput`, `PushPolicyNeeds`, `PushRefDecision`, `PushPolicyResult`. Core's `readPack` gains `maxObjectBytes`, and `deltaResultSize` is exported from `pack/apply-delta`.

- [#1](https://github.com/leed-ai/git-gateway/pull/1) [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe) Thanks [@kingmesal](https://github.com/kingmesal)! - Add the smart-HTTP proxy. The contract gains the proxy hooks (`Authenticator`, `Authorizer`, `BranchPolicy`, `AuditHook`) and their self-described schemas (`Principal`, `RefPattern`, `BranchRule`, `BranchPolicyConfig`, `PolicyResult`, `AuditEvent`, `SmartHttpConfig`), plus `readCredential` (the HTTP Basic password as a bearer credential). Core gains a streaming zlib inflater and `PackScanner`, which walks a pack as it streams past and collects its commits without buffering it, and `parseReceivePackRequest` now reports where the pack starts. The worker gains `createGatewayApp` (Hono routes for `/<repo>.git/info/refs`, `git-upload-pack` and `git-receive-pack`, with authentication, authorization and branch policy as middleware, per-request upstream credentials, streamed bodies, a decision cache, audit events and request-id logging), `RuleBranchPolicy` and `createGatewayWorker`. Fast-forward-only updates are proven from storage or from the pushed pack while it streams, holding back the pack checksum until they are. The new `JwtAuthenticator` verifies JWTs against an issuer's JWKS (OIDC discovery, key rotation, RS/PS/ES/EdDSA). The testkit gains `GitSandbox` and `serveStreaming` for driving the git binary against a streaming gateway.

### Patch Changes

- [#7](https://github.com/leed-ai/git-gateway/pull/7) [`6c76ff1`](https://github.com/leed-ai/git-gateway/commit/6c76ff1687feb0da848b9795c67eaf7ecc77d7ac) Thanks [@kingmesal](https://github.com/kingmesal)! - A non-fast-forward push to a fast-forward-only branch is now always refused in-protocol (`ng <ref> <reason>`), even when the storage host gives up on the deliberately truncated pack before the gateway has recorded its verdict; it used to be answered 502 "storage host unreachable". `SmartHttpConfig.maxVerdictWaitMs` (default 60000) bounds that wait; genuine storage failures are still 502 and nothing is written.
  
  `StorageBackend` gains an optional capability, `isAncestor(repo, ancestor, descendant): Promise<boolean | null>`. The proxy proves fast-forwards with it (one call per commit where the pushed pack meets storage) and falls back to the `readCommit` walk when a backend lacks it. `GitLabBackend` implements it with the merge-base API and `MemoryBackend` in memory; the backend contract suite checks it for backends that offer it. Artifacts has no equivalent call and keeps the walk.
- Updated dependencies [[`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`6c76ff1`](https://github.com/leed-ai/git-gateway/commit/6c76ff1687feb0da848b9795c67eaf7ecc77d7ac), [`16bcfd1`](https://github.com/leed-ai/git-gateway/commit/16bcfd1f7539cbbcfdf74cc0968de477527064c2), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe)]:
  - @leed-ai/git-gateway-contract@0.1.0
  - @leed-ai/git-gateway-core@0.1.0
