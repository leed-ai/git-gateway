---
'@leed-ai/git-gateway-contract': minor
'@leed-ai/git-gateway-core': minor
'@leed-ai/git-gateway-testkit': minor
'@leed-ai/git-gateway-backend-artifacts': minor
'@leed-ai/git-gateway-backend-gitlab': minor
---

Add the storage backend layer. The contract gains the `StorageBackend` interface and its self-described schemas (`StorageRepoInfo`, `StorageTreeEntry`, `StorageRef`, `StorageLogOptions`, `GitAccess`, `GitRemote`) with shared input parsing and error helpers. Core gains a pack reader (OFS and REF deltas, thin packs, a pure-JS zlib inflater that reports stream ends), ref-advertisement and upload-pack codecs, a `fetch`-based smart-HTTP client, and an `invalid_pack` error. The testkit gains `MemoryBackend` (the full contract with a real protocol v0/v1 smart-HTTP server: shallow, partial-clone filters, thin packs, atomic pushes) and the backend contract suite every backend runs unchanged. New backends: `ArtifactsBackend` over the Workers binding, with `ArtifactsRestControl` over the `cloudflare` SDK outside Workers; and `GitLabBackend` over REST API v4 and git smart HTTP.
