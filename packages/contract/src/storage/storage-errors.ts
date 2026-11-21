// SPDX-License-Identifier: Apache-2.0
import { gatewayError, type GatewayError } from '../gateway-error.ts';

/** The repo_not_found error a backend throws for a call on a missing repository. */
export function repoNotFound(repo: string): GatewayError {
  return gatewayError('repo_not_found', `Repository not found: ${repo}`, { repo });
}

/** The repo_exists error a backend throws when createRepo names a taken repository. */
export function repoExists(repo: string): GatewayError {
  return gatewayError('repo_exists', `Repository already exists: ${repo}`, { repo });
}

/**
 * The storage_unavailable error a backend throws when its host fails or answers with something
 * the contract cannot represent. `cause` is summarised in the message; callers pass host errors,
 * never credentials.
 */
export function storageUnavailable(what: string, cause: unknown): GatewayError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return gatewayError('storage_unavailable', `Storage backend failed: ${what}: ${reason}`, {
    retryable: true,
  });
}
