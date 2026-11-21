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

`gateway-app` (`createGatewayApp`) is the same gateway as a Hono app. Each request to `/<repo>.git/…` runs route resolution, authentication (401 with `WWW-Authenticate: Basic` when it fails, so git asks its credential helper), authorization (refused in-protocol with `ERR`) and, for pushes, the branch policy (refused per ref with `ng <ref> <reason>`; a push is forwarded only when every update is allowed). The request then streams to the storage host with a credential minted for it alone. Fast-forward-only updates are proven from storage, or from the pushed pack as it streams, holding back the pack checksum until they are proven. See the [design](https://github.com/leed-ai/git-gateway/blob/main/docs/design.md#smart-http-proxy).

**Push events.** After the storage host accepts a push through the proxy, the refs its report marks `ok` are passed to `onPush` (through `waitUntil`; failures go to `onPushError` and never change the response). The RPC service does the same for every ref update it writes. Sync rules (`gateway.syncRules` on the app, `config.syncRules` on the RPC service) start a `SyncBranchWorkflow` after every accepted push to a rule's `from` branch; pass the binding as `syncWorkflow`, without which a gateway with sync rules refuses to start.

## License

Apache-2.0
