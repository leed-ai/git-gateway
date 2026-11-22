---
'@leed-ai/git-gateway-contract': minor
'@leed-ai/git-gateway-core': minor
'@leed-ai/git-gateway-worker': minor
---

An optional `PushPolicy` hook (`GatewayAppOptions.pushPolicy`) runs after the branch policy on every push and can refuse updates in-protocol for what they change. `needs()` decides per push whether `check()` gets changed paths: the commits each update brings with every `ChangedPath` (path, change, modes, ids, size), computed from the pushed pack and storage within new bounds (`SmartHttpConfig.maxPushPolicyPackBytes`, `maxPushPolicyObjectBytes`, `maxPushPolicyReads`, `maxChangedPaths`); a push that cannot be checked within them is refused. New schemas: `ChangedPath`, `PushedCommit`, `PushPolicyUpdate`, `PushPolicyInput`, `PushPolicyNeeds`, `PushRefDecision`, `PushPolicyResult`. Core's `readPack` gains `maxObjectBytes`, and `deltaResultSize` is exported from `pack/apply-delta`.
