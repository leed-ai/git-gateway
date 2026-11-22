---
'@leed-ai/git-gateway-backend-artifacts': patch
'@leed-ai/git-gateway-contract': patch
'@leed-ai/git-gateway-testkit': patch
---

Reading an id as the wrong kind of object is `null` on Cloudflare Artifacts, as the `StorageBackend` contract requires. The live binding refuses `readTree` of a blob (and similar reads) with an error whose code does not survive, only the message "Invalid object requested. SHA must identify a commit or a tree. <sha> is a blob."; the backend surfaced that as `storage_unavailable`, so any push whose thin pack deltas against an existing blob was refused as "the push could not be checked". `readCommit`, `readTree`, `readBlob` and `readFile` now map exactly that refusal to `null` (by its message, or by probing the other kinds when an `INTERNAL_ERROR` or code-less error does not say), and every other failure still surfaces. The contract now spells the rule out on `readCommit`, `readTree` and `readBlob`, and the backend contract suite gains a case reading an object by asking for each kind in turn.
