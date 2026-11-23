---
'@leed-ai/git-gateway-auth-jwt': patch
'@leed-ai/git-gateway-backend-artifacts': patch
'@leed-ai/git-gateway-backend-gitlab': patch
'@leed-ai/git-gateway-contract': patch
'@leed-ai/git-gateway-core': patch
'@leed-ai/git-gateway-testkit': patch
'@leed-ai/git-gateway-worker': patch
---

The `zod` peer dependency now requires 4.6.0 or later (`^4.6.0`, was `^4`). Older 4.x releases do not behave as the published contract says: before 4.5.0 a commit action refused for invalid base64 `content` reports the issue with an empty path instead of naming the `content` field, and the generated JSON Schema differs (including a `FilePath` pattern that no longer gives the same verdict as the schema); before 4.6.0 `z.toJSONSchema` emits a different email pattern, so the generated JSON Schema still differs from the one published. `hono` (`^4`) and `cloudflare` (`^5`) are unchanged; their lowest versions pass the whole suite.
