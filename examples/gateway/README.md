# Example gateway Worker

A deployable Worker that shows how a deployment composes the git-gateway packages: git smart HTTP at `/<repo>.git` over a Cloudflare Artifacts namespace, JWT credentials verified against the issuer's JWKS (`JwtAuthenticator`), repository access from the token's roles, and `main` protected from force pushes and deletion (`RuleBranchPolicy`). It grows the RPC entrypoint and Workflows as those packages land.

```bash
bun run dev      # wrangler dev on http://localhost:8787
bun run build    # wrangler deploy --dry-run --outdir dist (CI builds it this way; nothing deploys it)
bun run test     # tests inside workerd via @cloudflare/vitest-plugin
```

Configuration is in [`wrangler.jsonc`](wrangler.jsonc).
