// SPDX-License-Identifier: Apache-2.0
import type { Principal } from '@leed-ai/git-gateway-contract/proxy/principal';
import type { RefUpdate } from '@leed-ai/git-gateway-contract/schemas/ref-update';
import type { ReceivePackRequest } from '@leed-ai/git-gateway-core/schemas/receive-pack';

import type { GitRequest } from './git-route.ts';

/** A fast-forward-only update whose ancestry is proven only once the pushed pack has been scanned. */
export interface PendingFastForward {
  readonly update: RefUpdate;
  /** The policy's reason, shown to the user if the update turns out not to be a fast-forward. */
  readonly reason: string;
}

/** A push the branch policy let through, ready to forward. */
export interface AllowedPush {
  readonly request: ReceivePackRequest;
  /** The whole request body from its first byte. */
  readonly body: ReadableStream<Uint8Array>;
  /** Where the pack starts in `body`. */
  readonly headLength: number;
  /** Updates still to be proven fast-forwards from the pack as it streams past. */
  readonly pending: readonly PendingFastForward[];
  /**
   * Every update of the push, when the push policy is still to check them with changed paths
   * computed from the pack; null when there is nothing left for it to check.
   */
  readonly policyUpdates: readonly RefUpdate[] | null;
}

/** The Hono environment of the gateway app: what each middleware leaves for the next. */
export interface GatewayEnv {
  Variables: {
    /** Set first: the id of this request, also returned as X-Request-Id. */
    requestId: string;
    /** Set by route resolution: the repository and endpoint addressed. */
    git: GitRequest;
    /** Set by authentication. */
    principal: Principal;
    /** Set by the branch-policy middleware on a receive-pack request it lets through. */
    push: AllowedPush;
  };
}
