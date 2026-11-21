// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import {
  commitWorkflowId,
  syncWorkflowId,
  workflowInstanceId,
} from '../../src/workflows/workflow-instance-id.ts';
import { startWorkflowOnce } from '../../src/workflows/workflow-starter.ts';
import { FakeWorkflowStarter } from '../helpers/fake-workflow.ts';

describe('workflow instance ids', () => {
  it('are deterministic, distinct per input and valid Workflows ids', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), fc.string(), async (repo, branch, key) => {
        const id = await commitWorkflowId(repo, branch, key);
        expect(id).toMatch(/^commit-[0-9a-f]{40}$/);
        expect(id.length).toBeLessThanOrEqual(100);
        expect(await commitWorkflowId(repo, branch, key)).toBe(id);
      }),
      { numRuns: 100 },
    );
    expect(await commitWorkflowId('a', 'b', 'c')).not.toBe(await commitWorkflowId('a', 'b', 'd'));
    // Parts are NUL-joined, so shifting text between parts changes the id.
    expect(await commitWorkflowId('ab', 'c', 'd')).not.toBe(await commitWorkflowId('a', 'bc', 'd'));
    expect(await syncWorkflowId('r', 'main', 'staging', '1'.repeat(40))).toMatch(/^sync-[0-9a-f]{40}$/);
  });

  it('refuses a prefix Workflows would not accept', async () => {
    await expect(workflowInstanceId('Bad Prefix', [])).rejects.toThrow(RangeError);
  });
});

describe('startWorkflowOnce', () => {
  it('creates an instance once and finds it afterwards', async () => {
    const starter = new FakeWorkflowStarter<{ n: number }>();
    expect(await startWorkflowOnce(starter, 'commit-1', { n: 1 })).toBe('created');
    expect(await startWorkflowOnce(starter, 'commit-1', { n: 2 })).toBe('existing');
    expect(starter.instances.get('commit-1')).toEqual({ n: 1 });
  });

  it('leaves a live or finished instance standing', async () => {
    for (const status of [
      'queued',
      'running',
      'waiting',
      'paused',
      'waitingForPause',
      'complete',
      'unknown',
    ]) {
      const starter = new FakeWorkflowStarter<{ n: number }>();
      await startWorkflowOnce(starter, 'commit-1', { n: 1 });
      starter.statuses.set('commit-1', status);
      expect(await startWorkflowOnce(starter, 'commit-1', { n: 1 })).toBe('existing');
      expect(starter.restarts.size).toBe(0);
      expect(starter.statuses.get('commit-1')).toBe(status);
    }
  });

  it('restarts an errored or terminated instance instead of reporting it as handled', async () => {
    for (const status of ['errored', 'terminated']) {
      const starter = new FakeWorkflowStarter<{ n: number }>();
      await startWorkflowOnce(starter, 'commit-1', { n: 1 });
      starter.statuses.set('commit-1', status);
      expect(await startWorkflowOnce(starter, 'commit-1', { n: 1 })).toBe('restarted');
      expect(starter.restarts.get('commit-1')).toBe(1);
      expect(starter.statuses.get('commit-1')).toBe('queued');
      // Once running again, a further retry finds it live and leaves it alone.
      expect(await startWorkflowOnce(starter, 'commit-1', { n: 1 })).toBe('existing');
      expect(starter.restarts.get('commit-1')).toBe(1);
    }
  });

  it('reports storage_unavailable when a dead instance cannot be restarted', async () => {
    const starter = new FakeWorkflowStarter<{ n: number }>();
    await startWorkflowOnce(starter, 'commit-1', { n: 1 });
    starter.statuses.set('commit-1', 'errored');
    const handle = await starter.get('commit-1');
    starter.get = async () => ({ ...handle, restart: () => Promise.reject(new Error('refused')) });
    await expect(startWorkflowOnce(starter, 'commit-1', { n: 1 })).rejects.toThrow(/storage_unavailable/);
  });

  it('reports storage_unavailable when the binding fails', async () => {
    const starter = new FakeWorkflowStarter<{ n: number }>();
    starter.failure = new Error('down');
    await expect(startWorkflowOnce(starter, 'commit-1', { n: 1 })).rejects.toThrow(/storage_unavailable/);
  });
});
