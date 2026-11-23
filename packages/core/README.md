# @leed-ai/git-gateway-core

Platform-free git primitives for git-gateway: pkt-line, receive-pack parsing, object encoding, packs, tree editing, file-level merge.

Part of [git-gateway](https://github.com/leed-ai/git-gateway). Status: in development; see the [design](https://github.com/leed-ai/git-gateway/blob/main/docs/design.md).

Peer dependencies: `zod` (`^4.6.0`). Install them alongside this package.

No Cloudflare imports: everything runs in Bun, Node and Workers. Each module is its own export (`@leed-ai/git-gateway-core/<module>`), named exports only:

| Module                                                                                | What it does                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pkt-line/encode`, `pkt-line/decode`, `pkt-line/pkt-line-reader`                      | pkt-line framing: encode, decode a buffer, read a stream one packet at a time and hand the rest on.                                                                                                                                                                                                                          |
| `receive-pack/parse-request`                                                          | Parses the leading commands, capabilities, push options and shallow lines of a git-receive-pack body without reading the pack, and returns a stream that replays the body. Bounded: at most 10000 shallow lines and commands, 100 push options and `maxHeadBytes` (8 MiB) before the pack; the body is cancelled on failure. |
| `receive-pack/encode-request`, `receive-pack/report-status`, `receive-pack/side-band` | Builds receive-pack requests; parses and writes report-status (`ok` / `ng <ref> <reason>`, `ERR`) with no side-band, side-band (1000-byte packets) or side-band-64k framing.                                                                                                                                                 |
| `objects/hash-object`, `objects/tree-object`, `objects/commit-object`                 | Blob, tree and commit encoding and decoding with ids identical to `git hash-object`.                                                                                                                                                                                                                                         |
| `pack/write-pack`, `pack/deflate`                                                     | Undeltified version 2 packs, zlib via `CompressionStream`; they pass `git index-pack --strict`.                                                                                                                                                                                                                              |
| `tree/edit-tree`, `tree/tree-overlay`, `tree/tree-reader`                             | Path edits of a tree that read only the directories along the edited paths (through a `readTree` callback) and rewrite only what changed.                                                                                                                                                                                    |
| `actions/apply-commit-actions`                                                        | Commit actions with GitLab Commits API semantics (create, update, upsert, delete, move, chmod), text or base64, and no-op detection. Rule failures throw the contract `GatewayError`.                                                                                                                                        |
| `merge/merge-trees`                                                                   | File-level three-way merge of trees against a merge base; conflicts come back as a sorted path list. Agrees with the contract's reference merge.                                                                                                                                                                             |
| `idempotency/find-idempotent-commit`                                                  | Finds the commit carrying a `Gateway-Idempotency-Key:` trailer within a bounded history window.                                                                                                                                                                                                                              |
| `commit/build-commit`                                                                 | Builds a commit from actions without a clone: the objects to pack and the ref update to push.                                                                                                                                                                                                                                |

Protocol and object problems throw a `CoreError` (`core-error`) whose `body` is a `CoreErrorBody`.

## Tests

```bash
bun run test              # unit and property tests, with the 90 % line-coverage gate
bun run test:conformance  # against the real git binary (GIT_BINARY overrides `git`)
bun run test:mutation     # Stryker mutation testing (nightly in CI)
```

## License

Apache-2.0
