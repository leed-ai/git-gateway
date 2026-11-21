// SPDX-License-Identifier: Apache-2.0
import { JwtAuthenticator } from '@leed-ai/git-gateway-auth-jwt/jwt-authenticator';
import { ArtifactsBackend } from '@leed-ai/git-gateway-backend-artifacts/artifacts-backend';
import type { ArtifactsNamespaceBinding } from '@leed-ai/git-gateway-backend-artifacts/artifacts-binding';
import type { Authorizer } from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import { withReadTokens } from '@leed-ai/git-gateway-worker/auth/read-token-auth';
import { createGatewayWorker } from '@leed-ai/git-gateway-worker/gateway-worker';
import { consoleLogger } from '@leed-ai/git-gateway-worker/logging/logger';
import { RuleBranchPolicy } from '@leed-ai/git-gateway-worker/policy/rule-branch-policy';
import { createGatewayService } from '@leed-ai/git-gateway-worker/rpc/gateway-service';

/** The example deployment's bindings, variables and secrets (wrangler.jsonc). */
export interface Env {
  /** The Artifacts namespace holding the repositories. */
  readonly ARTIFACTS: ArtifactsNamespaceBinding;
  /** The OIDC issuer whose JWTs are accepted. */
  readonly JWT_ISSUER: string;
  /** The audience those JWTs must carry. */
  readonly JWT_AUDIENCE: string;
  /** Where the repositories are served, e.g. https://git.example.com. */
  readonly PUBLIC_BASE_URL: string;
  /** Worker secret: the HMAC key read tokens are signed and verified with (32+ characters). */
  readonly READ_TOKEN_SECRET: string;
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
 * The RPC API for other Workers over a service binding (commits, reads, mintReadToken, …). A
 * token it mints clones its repository through the fetch handler below.
 */
export const GatewayService = createGatewayService((env: Env) => ({
  backend: new ArtifactsBackend({ binding: env.ARTIFACTS }),
  readTokenSecret: env.READ_TOKEN_SECRET,
  config: { publicBaseUrl: env.PUBLIC_BASE_URL },
}));

/**
 * The example deployment: git smart HTTP at /<repo>.git over Cloudflare Artifacts, JWT
 * credentials verified against the issuer's JWKS, read tokens from mintReadToken() accepted for
 * cloning their one repository, main protected from force pushes and deletion.
 */
export default createGatewayWorker<Env>((env) => ({
  backend: new ArtifactsBackend({ binding: env.ARTIFACTS }),
  ...withReadTokens({
    secret: env.READ_TOKEN_SECRET,
    authenticator: new JwtAuthenticator({ issuer: env.JWT_ISSUER, audience: [env.JWT_AUDIENCE] }),
    authorizer: roleAuthorizer,
  }),
  branchPolicy: new RuleBranchPolicy({
    rules: [
      { pattern: 'refs/heads/main', message: 'main is protected: force pushes and deletion are refused' },
    ],
  }),
  logger: consoleLogger,
  serviceName: 'git-gateway-example',
  smartHttp: { realm: 'git-gateway-example' },
}));
