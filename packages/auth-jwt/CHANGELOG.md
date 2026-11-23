# @leed-ai/git-gateway-auth-jwt

## 0.1.3

### Patch Changes

- [#25](https://github.com/leed-ai/git-gateway/pull/25) [`5c855c8`](https://github.com/leed-ai/git-gateway/commit/5c855c89993f30604072af140641ba68b144ebae) Thanks [@kingmesal](https://github.com/kingmesal)! - Type-checks against `@types/node` 26, whose Web Crypto and Web Streams types take only bytes over an `ArrayBuffer`. `sha1Bytes` and `deflate`/`inflate` in core, and `sha1Hex` in the contract's reference gateway, still accept any `Uint8Array` and pass it through unchanged; an array over shared memory, which those APIs refuse, is now copied first. The new `arrayBufferBacked` helper (in `core/bytes` and `contract/reference/bytes`) does that. `DecodedJwt.signingInput` and `signature` in auth-jwt, and `decodeBase64Url`'s result, are now typed `Uint8Array<ArrayBuffer>`, which they always were.

- [#25](https://github.com/leed-ai/git-gateway/pull/25) [`5c855c8`](https://github.com/leed-ai/git-gateway/commit/5c855c89993f30604072af140641ba68b144ebae) Thanks [@kingmesal](https://github.com/kingmesal)! - The `zod` peer dependency now requires 4.6.0 or later (`^4.6.0`, was `^4`). Older 4.x releases do not behave as the published contract says: before 4.5.0 a commit action refused for invalid base64 `content` reports the issue with an empty path instead of naming the `content` field, and the generated JSON Schema differs (including a `FilePath` pattern that no longer gives the same verdict as the schema); before 4.6.0 `z.toJSONSchema` emits a different email pattern, so the generated JSON Schema still differs from the one published. `hono` (`^4`) and `cloudflare` (`^5`) are unchanged; their lowest versions pass the whole suite.
- Updated dependencies [[`5c855c8`](https://github.com/leed-ai/git-gateway/commit/5c855c89993f30604072af140641ba68b144ebae), [`5c855c8`](https://github.com/leed-ai/git-gateway/commit/5c855c89993f30604072af140641ba68b144ebae)]:
  - @leed-ai/git-gateway-contract@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [[`29c5507`](https://github.com/leed-ai/git-gateway/commit/29c5507ec5426477fd64a0f6df2ccaac19ec3e36)]:
  - @leed-ai/git-gateway-contract@0.1.2

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
