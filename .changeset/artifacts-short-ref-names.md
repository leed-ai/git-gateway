---
'@leed-ai/git-gateway-backend-artifacts': patch
---

`ArtifactsBackend` hands the binding short ref names. The live Artifacts binding resolves `main` (or a commit id) but answers nothing for `refs/heads/main`, so `resolveRef`, `readFile` and `log` returned null or empty on every live repository, even right after a successful commit. Full refs now lose their `refs/heads/` or `refs/tags/` prefix before reaching the binding. Smart-HTTP clone and push were not affected.
