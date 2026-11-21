// SPDX-License-Identifier: Apache-2.0
import { storageUnavailable } from '@leed-ai/git-gateway-contract/storage/storage-errors';

/**
 * The part of a Workflows instance handle (`WorkflowInstance`) the gateway uses: read its status,
 * or run it again from the start with the params it was created with.
 */
export interface WorkflowHandle {
  readonly id: string;
  /** The instance's current status; `status` is one of the Workflows instance states. */
  status(): Promise<{ readonly status: string }>;
  /** Runs the instance again from its first step, with the params it was created with. */
  restart(): Promise<void>;
}

/**
 * The part of a Workflows binding (`env.COMMIT_WORKFLOW`) the gateway uses: start an instance
 * under a chosen id, or look one up. A real `Workflow<P>` binding satisfies it; tests pass a fake.
 */
export interface WorkflowStarter<P> {
  /** Starts an instance with this id and params; rejects when the id is already taken. */
  create(options: { id: string; params: P }): Promise<{ readonly id: string }>;
  /** The instance with this id; rejects when there is none. */
  get(id: string): Promise<WorkflowHandle>;
}

/**
 * What {@link startWorkflowOnce} did: started a new instance, found a live or finished one
 * already under the id, or found a dead one (errored or terminated) and restarted it.
 */
export type WorkflowStart = 'created' | 'existing' | 'restarted';

/** Instance states after which the instance will never run again unless restarted. */
const DEAD_STATES: ReadonlySet<string> = new Set(['errored', 'terminated']);

/**
 * Starts a Workflow instance under a deterministic id, at most once while it lives: when the id
 * is already taken by a queued, running, waiting, paused or complete instance (the same write was
 * handed off before), that instance stands and nothing new starts. When the instance under the id
 * is dead — errored after its retries ran out, or terminated — it is restarted, so retrying the
 * same write is never answered by an instance that will not run. Restarting is safe because the
 * workflows' steps are idempotent. Throws storage_unavailable when the instance can be neither
 * created nor found, or when its status cannot be read or it cannot be restarted.
 */
export async function startWorkflowOnce<P>(
  starter: WorkflowStarter<P>,
  id: string,
  params: P,
): Promise<WorkflowStart> {
  try {
    await starter.create({ id, params });
    return 'created';
  } catch (createError) {
    let handle: WorkflowHandle;
    try {
      handle = await starter.get(id);
    } catch {
      throw storageUnavailable(`start workflow instance ${id}`, createError);
    }
    try {
      const { status } = await handle.status();
      if (!DEAD_STATES.has(status)) return 'existing';
      await handle.restart();
      return 'restarted';
    } catch (error) {
      throw storageUnavailable(`restart workflow instance ${id}`, error);
    }
  }
}
