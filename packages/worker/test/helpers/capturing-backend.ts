// SPDX-License-Identifier: Apache-2.0
import type { GitRemote } from '@leed-ai/git-gateway-contract/storage/git-remote';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';

/** A memory backend that remembers every credential its git remotes carried, to prove none leaks. */
export class CapturingBackend extends MemoryBackend {
  readonly credentials: string[] = [];

  override async gitRemote(name: string, access: string): Promise<GitRemote> {
    const remote = await super.gitRemote(name, access);
    for (const value of Object.values(remote.headers)) {
      this.credentials.push(value, value.replace(/^Bearer /, ''));
    }
    return remote;
  }
}

/** Every string anywhere inside a JSON-like value. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}
