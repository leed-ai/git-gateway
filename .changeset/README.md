# Changesets

Every change to a published package (`packages/*`) needs a changeset, which records the semver bump and the line that goes into the changelog:

```bash
bun run changeset
```

Merging to `main` opens or updates the release PR and publishes all packages under the `next` dist-tag (`0.x.y-next.<timestamp>`). After the release PR is merged, a maintainer runs the `release` workflow to publish the new versions under `latest` (see `docs/RELEASING.md`). Changing a published contract schema is a breaking change.
