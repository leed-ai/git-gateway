# Changesets

Every change to a published package (`packages/*`) needs a changeset, which records the semver bump and the line that goes into the changelog:

```bash
bun run changeset
```

Merging to `main` opens or updates the release PR; merging the release PR publishes to npm with provenance. Every merge to `main` also publishes all packages under the `next` dist-tag (`0.x.y-next.<timestamp>`). Changing a published contract schema is a breaking change.
