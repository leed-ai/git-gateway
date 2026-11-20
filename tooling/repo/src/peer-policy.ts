// SPDX-License-Identifier: Apache-2.0

/**
 * The foundation libraries every package takes as peer dependencies, with the supported
 * major range each must be declared by. Raising a major is a one-line change here.
 */
export const PEER_POLICY: Readonly<Record<string, string>> = {
  zod: '^4',
  hono: '^4',
  cloudflare: '^5',
};

/** The names of the policy peers. */
export const PEER_NAMES: readonly string[] = Object.keys(PEER_POLICY);
