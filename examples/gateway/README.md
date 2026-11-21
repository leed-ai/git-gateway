# Example gateway Worker

A deployable Worker that shows how a deployment composes the git-gateway packages: git smart HTTP at `/<repo>.git` over a Cloudflare Artifacts namespace, JWT credentials verified against the issuer's JWKS (`JwtAuthenticator`), repository access from the token's roles, read tokens from `mintReadToken()` accepted for cloning their one repository (`withReadTokens`), and `main` protected from force pushes and deletion (`RuleBranchPolicy`). It also exports the RPC API as `GatewayService` for other Workers to bind. Set the read-token key with `wrangler secret put READ_TOKEN_SECRET` (32+ random characters) before deploying.

```bash
bun run dev      # wrangler dev on http://localhost:8787
bun run build    # wrangler deploy --dry-run --outdir dist (CI builds it this way; nothing deploys it)
bun run test     # tests inside workerd via @cloudflare/vitest-plugin
```

Configuration is in [`wrangler.jsonc`](wrangler.jsonc).
