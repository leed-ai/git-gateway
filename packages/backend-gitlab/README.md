# @leed-ai/git-gateway-backend-gitlab

git-gateway storage backend over a GitLab instance.

Part of [git-gateway](https://github.com/leed-ai/git-gateway). Status: in development; see the [design](https://github.com/leed-ai/git-gateway/blob/main/docs/design.md).

Peer dependencies: `zod` (`^4`). Install them alongside this package.

## Usage

```ts
import { GitLabBackend } from '@leed-ai/git-gateway-backend-gitlab/gitlab-backend';

const backend = new GitLabBackend({
  baseUrl: 'https://gitlab.com',
  token: env.GITLAB_TOKEN, // api, read_repository and write_repository on the group
  namespace: 'acme/sites', // repository <repo> is the project acme/sites/<repo>
});
```

Lifecycle, refs, blobs, files and history use the REST API (v4); commits and trees are read as git objects over smart HTTP; writes are git pushes to `gitRemote()`.

## Tests

`bun run test` runs the unit tests and the backend contract suite against a fake GitLab (REST and git over the in-memory backend). With `GITLAB_CONTRACT_TOKEN` and `GITLAB_CONTRACT_NAMESPACE` set (and optionally `GITLAB_CONTRACT_URL`), `bun run test:contract` also runs the suite against that real group, creating and deleting one disposable project per case.

## License

Apache-2.0
