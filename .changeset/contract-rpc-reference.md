---
'@leed-ai/git-gateway-contract': minor
---

Freeze the RPC contract: Zod schemas for every RPC input and output, commit action, ref update, tree entry, commit, error and configuration object; the `GitGateway` interface; an in-memory reference implementation; and the implementation-agnostic behaviour suite (`registerBehaviourSuite`). From the first `next` publish on, changing a contract schema is a breaking change.
