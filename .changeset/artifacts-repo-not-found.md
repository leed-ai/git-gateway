---
'@leed-ai/git-gateway-backend-artifacts': patch
---

Every `ArtifactsBackend` call on a repository that does not exist now throws `repo_not_found` (and `repoInfo` answers null, `deleteRepo` does nothing), as the contract requires. Previously it threw a retryable `storage_unavailable` when the live binding's error had lost its `NOT_FOUND` code and carried only the message "Repository not found: <name>." (or only the numeric code 10200).
