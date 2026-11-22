---
'@leed-ai/git-gateway-backend-artifacts': patch
---

`ArtifactsBackend.readBlob` and `readFile` work under `wrangler dev` with the remote Artifacts binding (`"remote": true`). That binding cannot carry a `Blob` back and fails with "Cannot serialize value: [object Blob]"; on exactly that error the backend now fetches the blob over the repository's git remote with a read token. The native binding in production is tried first and is unchanged.
