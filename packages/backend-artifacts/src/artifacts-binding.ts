// SPDX-License-Identifier: Apache-2.0

/**
 * The part of a repository handle (`ArtifactsRepo` in @cloudflare/workers-types) the backend
 * uses. Declared structurally so the package's types do not depend on the Workers globals; the
 * real binding's handles satisfy it. Every result is parsed with Zod before use.
 */
export interface ArtifactsRepoHandle {
  info(): Promise<unknown>;
  createToken(scope?: 'write' | 'read', ttl?: number): Promise<unknown>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  readBlob(hash: string): Promise<Blob | null>;
  readTree(hash: string): Promise<unknown>;
  readCommit(hash: string): Promise<unknown>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<unknown>;
}

/**
 * The part of the Artifacts binding (`Artifacts` in @cloudflare/workers-types, `env.ARTIFACTS`)
 * the backend uses: namespace-level create, get and delete.
 */
export interface ArtifactsNamespaceBinding {
  create(
    name: string,
    opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
  ): Promise<unknown>;
  get(name: string): Promise<ArtifactsRepoHandle>;
  delete(name: string): Promise<boolean>;
}

/** Releases a repository handle (an RPC stub) when the runtime gives it a disposer. */
export function releaseHandle(handle: ArtifactsRepoHandle): void {
  const dispose: unknown = Reflect.get(handle, Symbol.dispose);
  if (typeof dispose === 'function') Reflect.apply(dispose, handle, []);
}
