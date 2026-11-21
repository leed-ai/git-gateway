---
'@leed-ai/git-gateway-core': minor
---

Add the platform-free git primitives the gateway commits, merges and polices pushes with: a pkt-line codec and streaming reader; a receive-pack request parser that reads only the leading commands (with capabilities, push options and shallow lines) and replays the body untouched, plus a request encoder and report-status/side-band parsing and encoding; blob, tree and commit encoding and SHA-1 ids matching `git hash-object`; an undeltified pack writer (zlib via `CompressionStream`) whose packs pass `git index-pack --strict`; tree editing that reads only the trees along changed paths; commit actions with GitLab Commits API semantics and no-op detection; a file-level three-way tree merge that agrees with the contract's reference merge; an idempotency-key lookup over a bounded history window; and `buildCommit`, which ties them together. Every input and result is a self-described Zod schema.
