// SPDX-License-Identifier: Apache-2.0
import { utf8 } from '@leed-ai/git-gateway-contract/reference/bytes';
import { bytesToHex, sha1Bytes } from '@leed-ai/git-gateway-core/bytes';

/**
 * A Workflow instance id derived from what identifies the work, so starting the same work twice
 * names the same instance: `<prefix>-<40 hex digits>`, the SHA-1 of the parts joined by NUL.
 * Always at most 100 characters of `[a-z0-9-]` for prefixes of that alphabet, which is what
 * Workflows accepts as an instance id.
 */
export async function workflowInstanceId(prefix: string, parts: readonly string[]): Promise<string> {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(prefix)) {
    throw new RangeError(`workflowInstanceId: invalid prefix ${JSON.stringify(prefix)}`);
  }
  return `${prefix}-${bytesToHex(await sha1Bytes(utf8(parts.join('\0'))))}`;
}

/** The id of the CommitWorkflow instance for one idempotent commit. */
export function commitWorkflowId(repo: string, branch: string, idempotencyKey: string): Promise<string> {
  return workflowInstanceId('commit', [repo, branch, idempotencyKey]);
}

/** The id of the SyncBranchWorkflow instance that syncs `into` with `from` at one head of `from`. */
export function syncWorkflowId(repo: string, from: string, into: string, fromHead: string): Promise<string> {
  return workflowInstanceId('sync', [repo, from, into, fromHead]);
}
