---
'@leed-ai/git-gateway-backend-artifacts': patch
---

`ArtifactsBackend` hands the binding short ref names. The live Artifacts binding resolves `main` (or a commit id) but answers nothing for `refs/heads/main`, so `resolveRef`, `readFile` and `log` returned null or empty on every live repository, even right after a successful commit. Full refs now lose their `refs/heads/` or `refs/tags/` prefix before reaching the binding. Smart-HTTP clone and push were not affected.

`ArtifactsBackend.createRepo` on an existing name now throws `repo_exists`, as the contract requires, even when the live binding's error has lost its `ALREADY_EXISTS` code and carries only the message "repo already exists: <name>" (or only the numeric code 10201). It used to throw `storage_unavailable`.
