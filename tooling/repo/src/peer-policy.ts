// SPDX-License-Identifier: Apache-2.0

/**
 * The foundation libraries every package takes as peer dependencies, with the supported
 * caret range each must be declared by. A range starts at its major (`^4`) unless the code
 * needs a later minor: zod's floor is 4.6.0, the first release whose generated JSON Schema (the
 * email pattern; before 4.5 much more, with the base64 refusal path) matches the published
 * contract, as the nightly lowest-peers run checks. Raising a floor or a major is a one-line change here.
 */
export const PEER_POLICY: Readonly<Record<string, string>> = {
  zod: '^4.6.0',
  hono: '^4',
  cloudflare: '^5',
};

/** The names of the policy peers. */
export const PEER_NAMES: readonly string[] = Object.keys(PEER_POLICY);
