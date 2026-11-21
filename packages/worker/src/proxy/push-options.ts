// SPDX-License-Identifier: Apache-2.0
import type { ReceivePackRequest } from '@leed-ai/git-gateway-core/schemas/receive-pack';

/** The name of a push option: the part of `<name>[=<value>]` before the first "=". */
export function pushOptionName(option: string): string {
  const equals = option.indexOf('=');
  return equals === -1 ? option : option.slice(0, equals);
}

/**
 * The names of a push's options that are not on the allowlist, deduplicated, in the order sent.
 * A storage host acts on push options with the gateway's own credential — GitLab opens and
 * auto-merges merge requests (`merge_request.*`) and sets CI variables (`ci.variable`) — so an
 * option outside the allowlist would let a push reach refs the branch policy never saw.
 */
export function disallowedPushOptions(
  request: Pick<ReceivePackRequest, 'pushOptions'>,
  allowed: readonly string[],
): string[] {
  const permitted = new Set(allowed);
  const refused = new Set<string>();
  for (const option of request.pushOptions) {
    const name = pushOptionName(option);
    if (!permitted.has(name)) refused.add(name);
  }
  return [...refused];
}

/**
 * The reason a push refused for its options is given: the option names only (a value may be a
 * secret, such as a CI variable), each cut to 100 characters, at most five of them.
 */
export function pushOptionsReason(names: readonly string[]): string {
  const shown = names.slice(0, 5).map((name) => JSON.stringify(name.slice(0, 100)));
  const more = names.length > 5 ? ` and ${names.length - 5} more` : '';
  const noun = names.length === 1 ? 'push option' : 'push options';
  return `${noun} ${shown.join(', ')}${more} not allowed by this gateway`;
}
