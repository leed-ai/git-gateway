// SPDX-License-Identifier: Apache-2.0
import type {
  Authenticator,
  Authorizer,
  BranchPolicy,
  PushPolicy,
} from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import type { Principal } from '@leed-ai/git-gateway-contract/proxy/principal';
import type { SmartHttpConfig } from '@leed-ai/git-gateway-contract/proxy/smart-http-config';
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';

import type { AuditRecorder } from '../audit/audit-recorder.ts';
import type { DecisionCache } from '../cache/decision-cache.ts';
import type { Logger } from '../logging/logger.ts';
import type { OnPushHook } from '../workflows/on-push.ts';
import type { UpstreamFetch } from './upstream.ts';

/** A cached authentication or authorization decision. */
export type CachedDecision =
  | { readonly kind: 'principal'; readonly principal: Principal }
  | { readonly kind: 'allowed'; readonly allowed: boolean };

/** Everything the gateway's middleware and handlers share, resolved from the app options. */
export interface GatewayDeps {
  readonly backend: StorageBackend;
  readonly authenticator: Authenticator;
  readonly authorizer: Authorizer;
  readonly branchPolicy: BranchPolicy;
  /** The deployment's rules over what a push changes, run after the branch policy; undefined: none. */
  readonly pushPolicy: PushPolicy | undefined;
  readonly audit: AuditRecorder;
  readonly logger: Logger;
  readonly cache: DecisionCache<CachedDecision>;
  readonly config: SmartHttpConfig;
  /** How long decisions are cached, in milliseconds (GatewayConfig.authCacheSeconds). */
  readonly cacheTtlMs: number;
  readonly fetch: UpstreamFetch;
  readonly now: () => Date;
  /** Run after every accepted push (the sync rules and the deployment's hook); undefined: none. */
  readonly onPush: OnPushHook | undefined;
  /** Receives onPush failures after they are logged. */
  readonly onPushError: (error: unknown) => void;
}
