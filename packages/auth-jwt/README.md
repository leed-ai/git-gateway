# @leed-ai/git-gateway-auth-jwt

Reference git-gateway authenticator: bearer or Basic-password JWTs verified against a JWKS (OIDC).

Part of [git-gateway](https://github.com/leed-ai/git-gateway). Status: in development; see the [design](https://github.com/leed-ai/git-gateway/blob/main/docs/design.md).

Peer dependencies: `zod` (`^4`). Install them alongside this package.

## Usage

```ts
import { JwtAuthenticator } from '@leed-ai/git-gateway-auth-jwt/jwt-authenticator';

const authenticator = new JwtAuthenticator({
  issuer: 'https://auth.example.com', // keys discovered from <issuer>/.well-known/openid-configuration
  audience: ['git.example.com'],
  algorithms: ['RS256', 'ES256'],
});
```

git sends the token as the HTTP Basic password (a credential helper returns it); a Bearer header works too. The token must be signed by one of the issuer's keys with an accepted algorithm, carry the issuer, an accepted audience and an unexpired `exp`. Claims map to the principal (`sub`, `name`, `email`, `roles` by default; see `JwtClaimMapping`), and the principal's `expiresAt` is the token's expiry plus the clock tolerance (`clockToleranceSeconds`), so no cached decision outlives the token's acceptance. Keys are cached (`jwksCacheSeconds`) and refetched early when a token names an unknown `kid`; the issuer is asked at most every 10 seconds, and when a refetch fails the last keys fetched keep being served, so an issuer outage only stops authentication before any key has been fetched.

## License

Apache-2.0
