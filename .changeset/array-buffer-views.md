---
'@leed-ai/git-gateway-auth-jwt': patch
'@leed-ai/git-gateway-contract': patch
'@leed-ai/git-gateway-core': patch
---

Type-checks against `@types/node` 26, whose Web Crypto and Web Streams types take only bytes over an `ArrayBuffer`. `sha1Bytes` and `deflate`/`inflate` in core, and `sha1Hex` in the contract's reference gateway, still accept any `Uint8Array` and pass it through unchanged; an array over shared memory, which those APIs refuse, is now copied first. The new `arrayBufferBacked` helper (in `core/bytes` and `contract/reference/bytes`) does that. `DecodedJwt.signingInput` and `signature` in auth-jwt, and `decodeBase64Url`'s result, are now typed `Uint8Array<ArrayBuffer>`, which they always were.
