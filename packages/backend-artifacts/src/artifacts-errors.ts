// SPDX-License-Identifier: Apache-2.0
import { isGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import {
  repoExists,
  repoNotFound,
  storageUnavailable,
} from '@leed-ai/git-gateway-contract/storage/storage-errors';

import { ArtifactsBindingError } from './schemas/artifacts-binding-results.ts';

/** The Artifacts error code of something thrown, or null when it is not an Artifacts error. */
export function artifactsErrorCode(thrown: unknown): string | null {
  if (typeof thrown !== 'object' || thrown === null) return null;
  const parsed = ArtifactsBindingError.safeParse({
    code: Reflect.get(thrown, 'code'),
    message: Reflect.get(thrown, 'message'),
  });
  return parsed.success ? parsed.data.code : null;
}

/**
 * Translates a failure of a binding call on repository `repo` into a GatewayError: NOT_FOUND is
 * repo_not_found, ALREADY_EXISTS is repo_exists, everything else (in-progress states,
 * MEMORY_LIMIT, INTERNAL_ERROR, unparsable results) is storage_unavailable. GatewayErrors pass
 * through unchanged.
 */
export function toGatewayError(repo: string, what: string, thrown: unknown): Error {
  if (isGatewayError(thrown) && thrown instanceof Error) return thrown;
  const code = artifactsErrorCode(thrown);
  if (code === 'NOT_FOUND') return repoNotFound(repo);
  if (code === 'ALREADY_EXISTS') return repoExists(repo);
  return storageUnavailable(`Artifacts ${what}`, thrown);
}
