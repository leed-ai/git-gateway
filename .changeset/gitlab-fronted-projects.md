---
'@leed-ai/git-gateway-backend-gitlab': minor
'@leed-ai/git-gateway-testkit': minor
---

`GitLabBackend` can front existing projects: with `frontedProjects`, the reserved name `<prefix><projectId>` (default `gl-`) addresses a project by id when it lives under `frontedProjects.namespace`, and `createRepo` and `deleteRepo` refuse such names with `invalid_input`. The backend contract suite gains an `include` option to register a subset of its cases.
