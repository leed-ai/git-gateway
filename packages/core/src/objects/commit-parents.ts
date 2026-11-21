// SPDX-License-Identifier: Apache-2.0

const TREE_LINE = /^tree [0-9a-f]{40}$/;
const PARENT_LINE = /^parent [0-9a-f]{40}$/;

/** The header lines of a commit object's text: everything before the first blank line. */
export function commitHeaderLines(text: string): string[] {
  const end = text.indexOf('\n\n');
  return (end === -1 ? text : text.slice(0, end)).split('\n');
}

/**
 * The parent ids of a commit, read the way git reads them (parse_commit_buffer, fsck_commit): the
 * first header line must be `tree <sha>`, and the parents are only the `parent <sha>` lines that
 * follow it directly, in order. Returns null for a header git would read differently from a
 * naive scan — no leading tree line, a malformed parent line in that run, or a `parent` header
 * anywhere after it — so a caller proving ancestry treats the commit as unverifiable instead of
 * trusting parents git itself does not see.
 */
export function readCommitParents(headerLines: readonly string[]): string[] | null {
  if (!TREE_LINE.test(headerLines[0] ?? '')) return null;
  const parents: string[] = [];
  let index = 1;
  for (; index < headerLines.length; index += 1) {
    const line = headerLines[index] ?? '';
    if (!line.startsWith('parent ')) break;
    if (!PARENT_LINE.test(line)) return null;
    parents.push(line.slice(7));
  }
  for (; index < headerLines.length; index += 1) {
    if ((headerLines[index] ?? '').startsWith('parent ')) return null;
  }
  return parents;
}
