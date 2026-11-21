// SPDX-License-Identifier: Apache-2.0
import { JwtAuthenticator } from '@leed-ai/git-gateway-auth-jwt/jwt-authenticator';
import { ArtifactsBackend } from '@leed-ai/git-gateway-backend-artifacts/artifacts-backend';
import type { ArtifactsNamespaceBinding } from '@leed-ai/git-gateway-backend-artifacts/artifacts-binding';
import type { Authorizer } from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import { createGatewayWorker } from '@leed-ai/git-gateway-worker/gateway-worker';
import { consoleLogger } from '@leed-ai/git-gateway-worker/logging/logger';
import { RuleBranchPolicy } from '@leed-ai/git-gateway-worker/policy/rule-branch-policy';

/** The example deployment's bindings and variables (wrangler.jsonc). */
interface Env {
  /** The Artifacts namespace holding the repositories. */
  readonly ARTIFACTS: ArtifactsNamespaceBinding;
  /** The OIDC issuer whose JWTs are accepted. */
  readonly JWT_ISSUER: string;
  /** The audience those JWTs must carry. */
  readonly JWT_AUDIENCE: string;
}

/**
 * Repository access from the token's roles: "write:<repo>" may push and fetch, "read:<repo>" may
 * fetch. A deployment replaces this with its own rules (a database lookup, an API call).
 */
const roleAuthorizer: Authorizer = {
  authorize: async (principal, repo, operation) =>
    principal.roles.includes(`write:${repo}`) ||
    (operation === 'read' && principal.roles.includes(`read:${repo}`)),
};

/**
 * The example deployment: git smart HTTP at /<repo>.git over Cloudflare Artifacts, JWT
 * credentials verified against the issuer's JWKS, main protected from force pushes and deletion.
 */
export default createGatewayWorker<Env>((env) => ({
  backend: new ArtifactsBackend({ binding: env.ARTIFACTS }),
  authenticator: new JwtAuthenticator({ issuer: env.JWT_ISSUER, audience: [env.JWT_AUDIENCE] }),
  authorizer: roleAuthorizer,
  branchPolicy: new RuleBranchPolicy({
    rules: [
      { pattern: 'refs/heads/main', message: 'main is protected: force pushes and deletion are refused' },
    ],
  }),
  logger: consoleLogger,
  serviceName: 'git-gateway-example',
  smartHttp: { realm: 'git-gateway-example' },
}));
