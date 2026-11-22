# @leed-ai/git-gateway-auth-jwt

## 0.1.1

### Patch Changes

- Updated dependencies [[`b24d579`](https://github.com/leed-ai/git-gateway/commit/b24d5794077ba417f96ad253ec27c2e624829deb)]:
  - @leed-ai/git-gateway-contract@0.1.1

## 0.1.0

### Minor Changes

- [#1](https://github.com/leed-ai/git-gateway/pull/1) [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe) Thanks [@kingmesal](https://github.com/kingmesal)! - Add the smart-HTTP proxy. The contract gains the proxy hooks (`Authenticator`, `Authorizer`, `BranchPolicy`, `AuditHook`) and their self-described schemas (`Principal`, `RefPattern`, `BranchRule`, `BranchPolicyConfig`, `PolicyResult`, `AuditEvent`, `SmartHttpConfig`), plus `readCredential` (the HTTP Basic password as a bearer credential). Core gains a streaming zlib inflater and `PackScanner`, which walks a pack as it streams past and collects its commits without buffering it, and `parseReceivePackRequest` now reports where the pack starts. The worker gains `createGatewayApp` (Hono routes for `/<repo>.git/info/refs`, `git-upload-pack` and `git-receive-pack`, with authentication, authorization and branch policy as middleware, per-request upstream credentials, streamed bodies, a decision cache, audit events and request-id logging), `RuleBranchPolicy` and `createGatewayWorker`. Fast-forward-only updates are proven from storage or from the pushed pack while it streams, holding back the pack checksum until they are. The new `JwtAuthenticator` verifies JWTs against an issuer's JWKS (OIDC discovery, key rotation, RS/PS/ES/EdDSA). The testkit gains `GitSandbox` and `serveStreaming` for driving the git binary against a streaming gateway.

### Patch Changes

- Updated dependencies [[`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`6c76ff1`](https://github.com/leed-ai/git-gateway/commit/6c76ff1687feb0da848b9795c67eaf7ecc77d7ac), [`16bcfd1`](https://github.com/leed-ai/git-gateway/commit/16bcfd1f7539cbbcfdf74cc0968de477527064c2), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe)]:
  - @leed-ai/git-gateway-contract@0.1.0
