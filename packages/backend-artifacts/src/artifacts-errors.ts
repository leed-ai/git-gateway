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

/** The REST API's numeric code for "already exists", which the binding's ArtifactsError carries. */
const ALREADY_EXISTS_NUMERIC = 10201;

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Whether a failure of `create(repo)` says the repository already exists. The binding documents
 * code ALREADY_EXISTS (numeric 10201), and the local simulator sends it; the live binding was seen
 * to throw an error whose code did not survive, with only the message "repo already exists:
 * <name>". So the code, then the numeric code, then exactly that message naming this repository
 * (optionally after an "ArtifactsError: " prefix) are accepted.
 */
export function isAlreadyExists(thrown: unknown, repo: string): boolean {
  if (artifactsErrorCode(thrown) === 'ALREADY_EXISTS') return true;
  if (typeof thrown !== 'object' || thrown === null) return false;
  if (Reflect.get(thrown, 'numericCode') === ALREADY_EXISTS_NUMERIC) return true;
  const message: unknown = Reflect.get(thrown, 'message');
  return (
    typeof message === 'string' &&
    new RegExp(String.raw`^(?:ArtifactsError: )?repo already exists: ${escapeRegExp(repo)}$`, 'i').test(
      message.trim(),
    )
  );
}

/**
 * Translates a failure of a binding call on repository `repo` into a GatewayError: NOT_FOUND is
 * repo_not_found, ALREADY_EXISTS is repo_exists (for createRepo also when only the numeric code or
 * the message says so, see {@link isAlreadyExists}), everything else (in-progress states,
 * MEMORY_LIMIT, INTERNAL_ERROR, unparsable results) is storage_unavailable. GatewayErrors pass
 * through unchanged.
 */
export function toGatewayError(repo: string, what: string, thrown: unknown): Error {
  if (isGatewayError(thrown) && thrown instanceof Error) return thrown;
  const code = artifactsErrorCode(thrown);
  if (code === 'NOT_FOUND') return repoNotFound(repo);
  if (code === 'ALREADY_EXISTS' || (what === 'createRepo' && isAlreadyExists(thrown, repo)))
    return repoExists(repo);
  return storageUnavailable(`Artifacts ${what}`, thrown);
}
