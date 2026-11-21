---
'@leed-ai/git-gateway-contract': minor
'@leed-ai/git-gateway-worker': minor
---

`SmartHttpConfig.deniedStatus` (`'err'`, the default, or `403`) chooses how the smart-HTTP proxy answers an authorization refusal: in-protocol with an `ERR` packet as before, or HTTP 403 with the reason as a plain-text body, which git reports as "The requested URL returned error: 403". Branch-policy refusals stay in-protocol either way.
