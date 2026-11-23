---
'@leed-ai/git-gateway-worker': patch
'@leed-ai/git-gateway-contract': patch
---

No storage read is made while a receive-pack to the storage host is open. A push with fast-forwards to prove from its pack, or whose push policy asks for changed paths, used to stream to the host while the gateway read the repository with the pack checksum held back; a host that serialises per repository (the Artifacts local simulator in Wrangler 4.165+ locks a repository for the whole of each request) made those reads wait on the gateway's own push, and the push hung. Such a push is now read whole, proven and checked first, and only then sent to the host; a refusal sends nothing to storage. A push with nothing left to check still streams.

New `SmartHttpConfig.maxFastForwardPackBytes` (default 32 MiB) bounds the pack held for a fast-forward proof. A larger push still streams, with its checksum held back, but is proven from the pack alone, so an update whose proof needs commits from storage is refused as unverifiable. `maxVerdictWaitMs` now applies only to such a streamed push. `holdPush` joins `guardPush` in `proxy/push-guard`, and `guardPush` can resume a scan.
