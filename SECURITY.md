# Security policy

git-gateway authenticates users and guards writes to their repositories, so we treat security reports as the highest priority.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub's private vulnerability reporting:

<https://github.com/leed-ai/git-gateway/security/advisories/new>

Please include what you found, how to reproduce it, the affected package and version (or commit), and the impact you expect. A proof of concept against your own deployment is welcome; do not test against deployments you do not own.

We aim to acknowledge a report within 3 working days and to agree a disclosure date with you once a fix is ready. We credit reporters in the advisory unless you ask us not to.

## Supported versions

Until 1.0, only the latest published `0.x` release receives security fixes. `next` snapshots are for testing and are never patched.

## Scope

In scope: every `@leed-ai/git-gateway-*` package and the example Worker's configuration. Out of scope: vulnerabilities in a storage host (GitLab, Cloudflare Artifacts) itself, and deployments that change the gateway's code.
