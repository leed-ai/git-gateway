---
'@leed-ai/git-gateway-contract': minor
'@leed-ai/git-gateway-worker': patch
'@leed-ai/git-gateway-backend-gitlab': minor
'@leed-ai/git-gateway-testkit': minor
---

A non-fast-forward push to a fast-forward-only branch is now always refused in-protocol (`ng <ref> <reason>`), even when the storage host gives up on the deliberately truncated pack before the gateway has recorded its verdict; it used to be answered 502 "storage host unreachable". `SmartHttpConfig.maxVerdictWaitMs` (default 60000) bounds that wait; genuine storage failures are still 502 and nothing is written.

`StorageBackend` gains an optional capability, `isAncestor(repo, ancestor, descendant): Promise<boolean | null>`. The proxy proves fast-forwards with it (one call per commit where the pushed pack meets storage) and falls back to the `readCommit` walk when a backend lacks it. `GitLabBackend` implements it with the merge-base API and `MemoryBackend` in memory; the backend contract suite checks it for backends that offer it. Artifacts has no equivalent call and keeps the walk.
