# @leed-ai/git-gateway-contract

Zod schemas and the RPC interface of git-gateway (the API contract), with an in-memory reference implementation.

Part of [git-gateway](https://github.com/leed-ai/git-gateway). Status: in development; see the [design](https://github.com/leed-ai/git-gateway/blob/main/docs/design.md).

Peer dependencies: `zod` (`^4`). Install them alongside this package.

## Modules

Every module is its own export; there is no barrel.

| Export                          | Contents                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `./git-gateway`                 | `GitGateway` (the RPC interface) and `RPC_SCHEMAS`, the input and output schema per method.                                        |
| `./rpc/<method>`                | `<Method>Input` and `<Method>Output` schemas and types for each RPC method.                                                        |
| `./schemas/<name>`              | Shared schemas: `Sha`, names, `Identity`, `CommitAction`, `Commit`, `RefUpdate`, `TreeEntry`, `GatewayConfig`, `GatewayErrorBody`. |
| `./gateway-error`               | `GatewayError`, `readGatewayError` (also across Workers RPC), `isGatewayError`.                                                    |
| `./reference/reference-gateway` | `createReferenceGateway()`: the whole interface in memory.                                                                         |
| `./reference/clock`             | `steppingClock()`: a deterministic clock, for deterministic ids.                                                                   |
| `./behaviour/behaviour-suite`   | `registerBehaviourSuite()` and `BEHAVIOUR_CASES`: the suite every implementation must pass.                                        |

## Testing a consumer against the reference

```ts
import { createReferenceGateway } from '@leed-ai/git-gateway-contract/reference/reference-gateway';

const gateway = createReferenceGateway();
await gateway.createRepo({ repo: 'site' });
await gateway.commit({
  repo: 'site',
  branch: 'main',
  message: 'Seed',
  author: { name: 'CMS', email: 'cms@example.com' },
  idempotencyKey: 'seed-1',
  actions: [{ action: 'create', path: 'index.md', content: '# Hello\n' }],
});
```

## Running the behaviour suite against an implementation

```ts
import { describe, it } from 'vitest';
import { registerBehaviourSuite } from '@leed-ai/git-gateway-contract/behaviour/behaviour-suite';

registerBehaviourSuite({ describe, it }, { createGateway: () => myGateway, cleanup: true });
```

## License

Apache-2.0
