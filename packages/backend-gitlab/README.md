# @leed-ai/git-gateway-backend-gitlab

git-gateway storage backend over a GitLab instance.

Part of [git-gateway](https://github.com/leed-ai/git-gateway). Status: in development; see the [design](https://github.com/leed-ai/git-gateway/blob/main/docs/design.md).

Peer dependencies: `zod` (`^4.6.0`). Install them alongside this package.

## Usage

```ts
import { GitLabBackend } from '@leed-ai/git-gateway-backend-gitlab/gitlab-backend';

const backend = new GitLabBackend({
  baseUrl: 'https://gitlab.com',
  token: env.GITLAB_TOKEN, // api, read_repository and write_repository on the group
  namespace: 'acme/sites', // repository <repo> is the project acme/sites/<repo>
});
```

### Fronting existing projects

Projects that predate the gateway can be served without moving them. With `frontedProjects`, the reserved name `<prefix><projectId>` (default prefix `gl-`) addresses an existing project by id, provided it lives under `frontedProjects.namespace` at any depth:

```ts
const backend = new GitLabBackend({
  token: env.GITLAB_TOKEN,
  namespace: 'acme/sites', // where createRepo puts new repositories
  frontedProjects: { namespace: 'acme/customers' }, // gl-1234 is project 1234, if it is under acme/customers
});
```

A project id outside that namespace answers `repo_not_found`, so the token's other projects stay out of reach. Reserved names can be read and pushed, but `createRepo` and `deleteRepo` refuse them with `invalid_input`.

Lifecycle, refs, blobs, files and history use the REST API (v4); commits and trees are read as git objects over smart HTTP; writes are git pushes to `gitRemote()`.

## Tests

`bun run test` runs the unit tests and the backend contract suite against a fake GitLab (REST and git over the in-memory backend). With `GITLAB_CONTRACT_TOKEN` and `GITLAB_CONTRACT_NAMESPACE` set (and optionally `GITLAB_CONTRACT_URL`), `bun run test:contract` also runs the suite against that real group, creating and deleting one disposable project per case.

## License

Apache-2.0
