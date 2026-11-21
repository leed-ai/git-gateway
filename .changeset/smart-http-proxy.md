---
'@leed-ai/git-gateway-contract': minor
'@leed-ai/git-gateway-core': minor
'@leed-ai/git-gateway-worker': minor
'@leed-ai/git-gateway-auth-jwt': minor
'@leed-ai/git-gateway-testkit': minor
---

Add the smart-HTTP proxy. The contract gains the proxy hooks (`Authenticator`, `Authorizer`, `BranchPolicy`, `AuditHook`) and their self-described schemas (`Principal`, `RefPattern`, `BranchRule`, `BranchPolicyConfig`, `PolicyResult`, `AuditEvent`, `SmartHttpConfig`), plus `readCredential` (the HTTP Basic password as a bearer credential). Core gains a streaming zlib inflater and `PackScanner`, which walks a pack as it streams past and collects its commits without buffering it, and `parseReceivePackRequest` now reports where the pack starts. The worker gains `createGatewayApp` (Hono routes for `/<repo>.git/info/refs`, `git-upload-pack` and `git-receive-pack`, with authentication, authorization and branch policy as middleware, per-request upstream credentials, streamed bodies, a decision cache, audit events and request-id logging), `RuleBranchPolicy` and `createGatewayWorker`. Fast-forward-only updates are proven from storage or from the pushed pack while it streams, holding back the pack checksum until they are. The new `JwtAuthenticator` verifies JWTs against an issuer's JWKS (OIDC discovery, key rotation, RS/PS/ES/EdDSA). The testkit gains `GitSandbox` and `serveStreaming` for driving the git binary against a streaming gateway.
