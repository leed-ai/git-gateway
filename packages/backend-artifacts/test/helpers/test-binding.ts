// SPDX-License-Identifier: Apache-2.0
import type { ArtifactsNamespaceBinding } from '../../src/artifacts-binding.ts';

function isBinding(value: unknown): value is ArtifactsNamespaceBinding {
  if (typeof value !== 'object' || value === null) return false;
  return ['create', 'get', 'delete'].every((method) => typeof Reflect.get(value, method) === 'function');
}

/** The ARTIFACTS binding the test Worker is configured with (test/wrangler.jsonc). */
export function testBinding(env: Cloudflare.Env): ArtifactsNamespaceBinding {
  const binding: unknown = Reflect.get(env, 'ARTIFACTS');
  if (!isBinding(binding)) throw new Error('test/wrangler.jsonc must bind ARTIFACTS');
  return binding;
}
