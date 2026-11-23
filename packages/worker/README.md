# @leed-ai/git-gateway-worker

The git-gateway Cloudflare Worker: smart-HTTP proxy, auth and branch-policy pipeline, RPC entrypoint and Workflows.

Part of [git-gateway](https://github.com/leed-ai/git-gateway). Status: in development; see the [design](https://github.com/leed-ai/git-gateway/blob/main/docs/design.md).

Peer dependencies: `zod` (`^4`), `hono` (`^4`). Install them alongside this package.

## Usage

```ts
import { createGatewayWorker } from '@leed-ai/git-gateway-worker/gateway-worker';
import { consoleLogger } from '@leed-ai/git-gateway-worker/logging/logger';
import { RuleBranchPolicy } from '@leed-ai/git-gateway-worker/policy/rule-branch-policy';

export default createGatewayWorker((env) => ({
  backend, // any StorageBackend, e.g. ArtifactsBackend over env.ARTIFACTS
  authenticator, // e.g. JwtAuthenticator from @leed-ai/git-gateway-auth-jwt
  authorizer: { authorize: async (principal, repo, operation) => true },
  branchPolicy: new RuleBranchPolicy({
    rules: [{ pattern: 'refs/heads/main', message: 'main is protected' }],
  }),
  audit: (event) => {}, // every authenticated operation
  logger: consoleLogger,
}));
```

`gateway-app` (`createGatewayApp`) is the same gateway as a Hono app. Each request to `/<repo>.git/…` runs route resolution, authentication (401 with `WWW-Authenticate: Basic` when it fails, so git asks its credential helper), authorization (refused in-protocol with `ERR`, or with HTTP 403 and the reason as the body when `smartHttp.deniedStatus` is `403`) and, for pushes, the branch policy (refused per ref with `ng <ref> <reason>`; a push is forwarded only when every update is allowed). The request then goes to the storage host with a credential minted for it alone, streamed when nothing is left to check. Fast-forward-only updates are proven from storage, or from the pushed pack; a push that needs its pack read (to prove a fast-forward, or to give the push policy changed paths) is read whole, bounded, and decided before the push to the storage host is opened, so no storage read ever waits on the gateway's own open push. A fast-forward push too large to hold streams instead, its pack checksum held back, and is proven from the pack alone. See the [design](https://github.com/leed-ai/git-gateway/blob/main/docs/design.md#smart-http-proxy).

Push options (`git push -o …`) are refused unless their name is in `smartHttp.allowedPushOptions` (default none): the storage host acts on them with the gateway's own credential — GitLab opens and auto-merges merge requests on `merge_request.*` — so an unchecked option would reach refs the branch policy never saw.

**Push events.** After the storage host accepts a push through the proxy, the refs its report marks `ok` are passed to `onPush` (through `waitUntil`; failures go to `onPushError` and never change the response). The RPC service does the same for every ref update it writes. Sync rules (`gateway.syncRules` on the app, `config.syncRules` on the RPC service) start a `SyncBranchWorkflow` after every accepted push to a rule's `from` branch; pass the binding as `syncWorkflow`, without which a gateway with sync rules refuses to start.

**Read tokens.** `mintReadToken()` (RPC) issues `ggr_…` tokens good for cloning one repository. Compose the proxy with `withReadTokens` (`auth/read-token-auth`) so they are accepted beside the deployment's own credentials, with the same secret as the RPC service:

```ts
import { withReadTokens } from '@leed-ai/git-gateway-worker/auth/read-token-auth';

createGatewayWorker((env) => ({
  backend,
  ...withReadTokens({ secret: env.READ_TOKEN_SECRET, authenticator, authorizer }),
  branchPolicy,
}));
```

A read-token principal (subject `read-token:<id>`, role `read:<repo>`) may fetch its repository until the token expires, and never push or read another; another authenticator's principal that claims the `read-token:` subject is refused.

## License

Apache-2.0
