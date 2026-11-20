# Example gateway Worker

A deployable Worker that shows how a deployment composes the git-gateway packages. Today it serves `GET /health`; it grows into the full gateway (smart-HTTP proxy, RPC entrypoint, Workflows) as the packages land.

```bash
bun run dev      # wrangler dev on http://localhost:8787
bun run build    # wrangler deploy --dry-run --outdir dist (CI builds it this way; nothing deploys it)
bun run test     # tests inside workerd via @cloudflare/vitest-plugin
```

Configuration is in [`wrangler.jsonc`](wrangler.jsonc).
