// SPDX-License-Identifier: Apache-2.0
import type { FatalError, StepConfig, StepResult, StepRunner } from '../../src/workflows/step-runner.ts';
import type { WorkflowHandle, WorkflowStarter } from '../../src/workflows/workflow-starter.ts';

/** What the fake engine throws when a test makes the isolate "die" mid-step. */
export class SimulatedCrash extends Error {
  override readonly name = 'SimulatedCrash';
}

/** The error a step throws to stop the instance, as `NonRetryableError` does in a Worker. */
export class FatalStepError extends Error {
  override readonly name = 'FatalStepError';
}

/** The {@link FatalError} tests pass, keeping the original message (and any GatewayError body). */
export const markFatal: FatalError = (error) => new FatalStepError(error.message);

/**
 * A Workflows engine in miniature, with the semantics the gateway's workflows rely on: a finished
 * step's result is stored (as a structured clone) and handed back on replay without running the
 * step again; a step that throws is retried up to its retry limit unless the error is fatal; a
 * step whose result was never stored — because the isolate died after the callback's side effects
 * but before the result was persisted — runs again on the next replay.
 */
export class FakeStepRunner implements StepRunner {
  /** Results stored per step name, as the engine would persist them. */
  readonly stored = new Map<string, unknown>();
  /** Every value a step callback returned, including ones lost to a simulated crash. */
  readonly outputs: unknown[] = [];
  /** How many times each step's callback ran. */
  readonly runs = new Map<string, number>();
  /** The configs steps were declared with. */
  readonly configs = new Map<string, StepConfig>();
  readonly #crashAfter = new Set<string>();

  /** Makes the next completed run of the named step die before its result is stored. */
  crashAfterNextRun(name: string): void {
    this.#crashAfter.add(name);
  }

  async do(name: string, config: StepConfig, callback: () => Promise<StepResult>): Promise<unknown> {
    this.configs.set(name, config);
    if (this.stored.has(name)) return this.stored.get(name);
    for (let attempt = 0; ; attempt += 1) {
      this.runs.set(name, (this.runs.get(name) ?? 0) + 1);
      try {
        const value = structuredClone(await callback());
        this.outputs.push(value);
        if (this.#crashAfter.delete(name)) throw new SimulatedCrash(`isolate died after step ${name}`);
        this.stored.set(name, value);
        return value;
      } catch (error) {
        if (error instanceof SimulatedCrash || error instanceof FatalStepError) throw error;
        if (attempt >= config.retries.limit) throw error;
      }
    }
  }
}

/** A Workflows binding in miniature: records instances and refuses a taken id, as the real one does. */
export class FakeWorkflowStarter<P> implements WorkflowStarter<P> {
  readonly instances = new Map<string, P>();
  /** Each instance's status, as `WorkflowInstance.status()` reports it; new instances are queued. */
  readonly statuses = new Map<string, string>();
  /** How many times each instance was restarted. */
  readonly restarts = new Map<string, number>();
  /** How many create calls were made (including refused ones). */
  creates = 0;
  /** When set, every call rejects with this error (an unavailable binding). */
  failure: Error | null = null;

  async create({ id, params }: { id: string; params: P }): Promise<{ id: string }> {
    this.creates += 1;
    if (this.failure !== null) throw this.failure;
    if (this.instances.has(id)) throw new Error(`instance ${id} already exists`);
    this.instances.set(id, structuredClone(params));
    this.statuses.set(id, 'queued');
    return { id };
  }

  async get(id: string): Promise<WorkflowHandle> {
    if (this.failure !== null) throw this.failure;
    if (!this.instances.has(id)) throw new Error(`instance ${id} not found`);
    return {
      id,
      status: async () => {
        if (this.failure !== null) throw this.failure;
        return { status: this.statuses.get(id) ?? 'unknown' };
      },
      restart: async () => {
        if (this.failure !== null) throw this.failure;
        this.restarts.set(id, (this.restarts.get(id) ?? 0) + 1);
        this.statuses.set(id, 'queued');
      },
    };
  }
}
