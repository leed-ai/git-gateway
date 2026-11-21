// SPDX-License-Identifier: Apache-2.0
import { RefPattern } from '@leed-ai/git-gateway-contract/proxy/branch-rule';

const SPECIAL = /[.+?^${}()|[\]\\]/g;

/**
 * Compiles a {@link RefPattern} glob into a matcher over whole fully qualified refs: "**" matches
 * any run of characters including "/", "*" any run inside one path component, everything else
 * itself.
 */
export function compileRefPattern(pattern: string): (ref: string) => boolean {
  const glob = RefPattern.parse(pattern);
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? '';
    if (char === '*' && glob[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') source += '[^/]*';
    else source += char.replace(SPECIAL, String.raw`\$&`);
  }
  const regex = new RegExp(`^${source}$`, 's');
  return (ref) => regex.test(ref);
}
