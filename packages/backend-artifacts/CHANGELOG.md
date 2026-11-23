# @leed-ai/git-gateway-backend-artifacts

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

- [#20](https://github.com/leed-ai/git-gateway/pull/20) [`b24d579`](https://github.com/leed-ai/git-gateway/commit/b24d5794077ba417f96ad253ec27c2e624829deb) Thanks [@kingmesal](https://github.com/kingmesal)! - Reading an id as the wrong kind of object is `null` on Cloudflare Artifacts, as the `StorageBackend` contract requires. The live binding refuses `readTree` of a blob (and similar reads) with an error whose code does not survive, only the message "Invalid object requested. SHA must identify a commit or a tree. <sha> is a blob."; the backend surfaced that as `storage_unavailable`, so any push whose thin pack deltas against an existing blob was refused as "the push could not be checked". `readCommit`, `readTree`, `readBlob` and `readFile` now map exactly that refusal to `null` (by its message, or by probing the other kinds when an `INTERNAL_ERROR` or code-less error does not say), and every other failure still surfaces. The contract now spells the rule out on `readCommit`, `readTree` and `readBlob`, and the backend contract suite gains a case reading an object by asking for each kind in turn.
- Updated dependencies [[`b24d579`](https://github.com/leed-ai/git-gateway/commit/b24d5794077ba417f96ad253ec27c2e624829deb)]:
  - @leed-ai/git-gateway-contract@0.1.1
  - @leed-ai/git-gateway-core@0.1.1

## 0.1.0

### Minor Changes

- [#1](https://github.com/leed-ai/git-gateway/pull/1) [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe) Thanks [@kingmesal](https://github.com/kingmesal)! - Add the storage backend layer. The contract gains the `StorageBackend` interface and its self-described schemas (`StorageRepoInfo`, `StorageTreeEntry`, `StorageRef`, `StorageLogOptions`, `GitAccess`, `GitRemote`) with shared input parsing and error helpers. Core gains a pack reader (OFS and REF deltas, thin packs, a pure-JS zlib inflater that reports stream ends), ref-advertisement and upload-pack codecs, a `fetch`-based smart-HTTP client, and an `invalid_pack` error. The testkit gains `MemoryBackend` (the full contract with a real protocol v0/v1 smart-HTTP server: shallow, partial-clone filters, thin packs, atomic pushes) and the backend contract suite every backend runs unchanged. New backends: `ArtifactsBackend` over the Workers binding, with `ArtifactsRestControl` over the `cloudflare` SDK outside Workers; and `GitLabBackend` over REST API v4 and git smart HTTP.

### Patch Changes

- [#15](https://github.com/leed-ai/git-gateway/pull/15) [`f457bb2`](https://github.com/leed-ai/git-gateway/commit/f457bb28cbd0645bcf61c46a7a3ab743a426e796) Thanks [@kingmesal](https://github.com/kingmesal)! - `ArtifactsBackend.readBlob` and `readFile` work under `wrangler dev` with the remote Artifacts binding (`"remote": true`). That binding cannot carry a `Blob` back and fails with "Cannot serialize value: [object Blob]"; on exactly that error the backend now fetches the blob over the repository's git remote with a read token. The native binding in production is tried first and is unchanged.

- [#13](https://github.com/leed-ai/git-gateway/pull/13) [`8f3b339`](https://github.com/leed-ai/git-gateway/commit/8f3b3395185726333b43a1955badcb079d5dd880) Thanks [@kingmesal](https://github.com/kingmesal)! - Every `ArtifactsBackend` call on a repository that does not exist now throws `repo_not_found` (and `repoInfo` answers null, `deleteRepo` does nothing), as the contract requires. Previously it threw a retryable `storage_unavailable` when the live binding's error had lost its `NOT_FOUND` code and carried only the message "Repository not found: <name>." (or only the numeric code 10200).

- [#9](https://github.com/leed-ai/git-gateway/pull/9) [`7887311`](https://github.com/leed-ai/git-gateway/commit/7887311daef6b0a1bb8f34143f27ab78de6eca5f) Thanks [@kingmesal](https://github.com/kingmesal)! - `ArtifactsBackend` hands the binding short ref names. The live Artifacts binding resolves `main` (or a commit id) but answers nothing for `refs/heads/main`, so `resolveRef`, `readFile` and `log` returned null or empty on every live repository, even right after a successful commit. Full refs now lose their `refs/heads/` or `refs/tags/` prefix before reaching the binding. Smart-HTTP clone and push were not affected.
  
  `ArtifactsBackend.createRepo` on an existing name now throws `repo_exists`, as the contract requires, even when the live binding's error has lost its `ALREADY_EXISTS` code and carries only the message "repo already exists: <name>" (or only the numeric code 10201). It used to throw `storage_unavailable`.
- Updated dependencies [[`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`6c76ff1`](https://github.com/leed-ai/git-gateway/commit/6c76ff1687feb0da848b9795c67eaf7ecc77d7ac), [`16bcfd1`](https://github.com/leed-ai/git-gateway/commit/16bcfd1f7539cbbcfdf74cc0968de477527064c2), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe), [`eeb1c3f`](https://github.com/leed-ai/git-gateway/commit/eeb1c3fe8185f39453291583886b66b629af5efe)]:
  - @leed-ai/git-gateway-contract@0.1.0
  - @leed-ai/git-gateway-core@0.1.0
