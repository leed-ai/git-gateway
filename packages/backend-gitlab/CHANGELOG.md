# @leed-ai/git-gateway-backend-gitlab

## 0.1.3

### Patch Changes

- [#25](https://github.com/leed-ai/git-gateway/pull/25) [`5c855c8`](https://github.com/leed-ai/git-gateway/commit/5c855c89993f30604072af140641ba68b144ebae) Thanks [@kingmesal](https://github.com/kingmesal)! - The `zod` peer dependency now requires 4.6.0 or later (`^4.6.0`, was `^4`). Older 4.x releases do not behave as the published contract says: before 4.5.0 a commit action refused for invalid base64 `content` reports the issue with an empty path instead of naming the `content` field, and the generated JSON Schema differs (including a `FilePath` pattern that no longer gives the same verdict as the schema); before 4.6.0 `z.toJSONSchema` emits a different email pattern, so the generated JSON Schema still differs from the one published. `hono` (`^4`) and `cloudflare` (`^5`) are unchanged; their lowest versions pass the whole suite.
- Updated dependencies [[`5c855c8`](https://github.com/leed-ai/git-gateway/commit/5c855c89993f30604072af140641ba68b144ebae), [`5c855c8`](https://github.com/leed-ai/git-gateway/commit/5c855c89993f30604072af140641ba68b144ebae)]:
  - @leed-ai/git-gateway-contract@0.1.3
  - @leed-ai/git-gateway-core@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [[`29c5507`](https://github.com/leed-ai/git-gateway/commit/29c5507ec5426477fd64a0f6df2ccaac19ec3e36)]:
  - @leed-ai/git-gateway-contract@0.1.2
  - @leed-ai/git-gateway-core@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [[`b24d579`](https://github.com/leed-ai/git-gateway/commit/b24d5794077ba417f96ad253ec27c2e624829deb)]:
  - @leed-ai/git-gateway-contract@0.1.1
  - @leed-ai/git-gateway-core@0.1.1

## 0.1.0

### Minor Changes

- [#1](https://github.com/leed-ai/git-gateway/pull/1) [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe) Thanks [@kingmesal](https://github.com/kingmesal)! - `GitLabBackend` can front existing projects: with `frontedProjects`, the reserved name `<prefix><projectId>` (default `gl-`) addresses a project by id when it lives under `frontedProjects.namespace`, and `createRepo` and `deleteRepo` refuse such names with `invalid_input`. The backend contract suite gains an `include` option to register a subset of its cases.

- [#7](https://github.com/leed-ai/git-gateway/pull/7) [`6c76ff1`](https://github.com/leed-ai/git-gateway/commit/6c76ff1687feb0da848b9795c67eaf7ecc77d7ac) Thanks [@kingmesal](https://github.com/kingmesal)! - A non-fast-forward push to a fast-forward-only branch is now always refused in-protocol (`ng <ref> <reason>`), even when the storage host gives up on the deliberately truncated pack before the gateway has recorded its verdict; it used to be answered 502 "storage host unreachable". `SmartHttpConfig.maxVerdictWaitMs` (default 60000) bounds that wait; genuine storage failures are still 502 and nothing is written.
  
  `StorageBackend` gains an optional capability, `isAncestor(repo, ancestor, descendant): Promise<boolean | null>`. The proxy proves fast-forwards with it (one call per commit where the pushed pack meets storage) and falls back to the `readCommit` walk when a backend lacks it. `GitLabBackend` implements it with the merge-base API and `MemoryBackend` in memory; the backend contract suite checks it for backends that offer it. Artifacts has no equivalent call and keeps the walk.

- [#1](https://github.com/leed-ai/git-gateway/pull/1) [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe) Thanks [@kingmesal](https://github.com/kingmesal)! - Add the storage backend layer. The contract gains the `StorageBackend` interface and its self-described schemas (`StorageRepoInfo`, `StorageTreeEntry`, `StorageRef`, `StorageLogOptions`, `GitAccess`, `GitRemote`) with shared input parsing and error helpers. Core gains a pack reader (OFS and REF deltas, thin packs, a pure-JS zlib inflater that reports stream ends), ref-advertisement and upload-pack codecs, a `fetch`-based smart-HTTP client, and an `invalid_pack` error. The testkit gains `MemoryBackend` (the full contract with a real protocol v0/v1 smart-HTTP server: shallow, partial-clone filters, thin packs, atomic pushes) and the backend contract suite every backend runs unchanged. New backends: `ArtifactsBackend` over the Workers binding, with `ArtifactsRestControl` over the `cloudflare` SDK outside Workers; and `GitLabBackend` over REST API v4 and git smart HTTP.

### Patch Changes

- Updated dependencies [[`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`6c76ff1`](https://github.com/leed-ai/git-gateway/commit/6c76ff1687feb0da848b9795c67eaf7ecc77d7ac), [`16bcfd1`](https://github.com/leed-ai/git-gateway/commit/16bcfd1f7539cbbcfdf74cc0968de477527064c2), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe)]:
  - @leed-ai/git-gateway-contract@0.1.0
  - @leed-ai/git-gateway-core@0.1.0
