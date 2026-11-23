# @leed-ai/git-gateway-backend-artifacts

git-gateway storage backend over Cloudflare Artifacts.

Part of [git-gateway](https://github.com/leed-ai/git-gateway). Status: in development; see the [design](https://github.com/leed-ai/git-gateway/blob/main/docs/design.md).

Peer dependencies: `zod` (`^4.6.0`), `cloudflare` (`^5`). Install them alongside this package.

## Usage

Inside a Worker, over the Artifacts binding (`"artifacts": [{ "binding": "ARTIFACTS", "namespace": "…" }]` in `wrangler.jsonc`):

```ts
import { ArtifactsBackend } from '@leed-ai/git-gateway-backend-artifacts/artifacts-backend';

const backend = new ArtifactsBackend({ binding: env.ARTIFACTS, tokenTtlSeconds: 300 });
const remote = await backend.gitRemote('acme-raw-content', 'write'); // { url, headers, expiresAt }
```

Every write is a `git-receive-pack` push to `gitRemote()`; Artifacts has no write or ref API. Outside a Worker, `ArtifactsRestControl` (`/artifacts-rest`) manages namespaces, repositories and tokens through the official `cloudflare` SDK, which is then a required peer.

`cloudflare` is optional: only `ArtifactsRestControl` uses it.

## Tests

`bun run test` runs the unit tests and the backend contract suite against the Artifacts local simulator (`test/wrangler.jsonc`; needs git 2.32+ on the PATH). `test/open-question-1.test.ts` pins how Artifacts treats stale and non-fast-forward ref updates.

## License

Apache-2.0
