// SPDX-License-Identifier: Apache-2.0

const WRAPPED_EXPRESSION = /^\$\{\{([\s\S]*)\}\}$/;

/** Splits text at depth-0 occurrences of an operator, outside string literals; undefined when unbalanced. */
function splitTopLevel(text: string, operator: '&&' | '||'): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char !== "'") continue;
      // A quote inside a GitHub expression string is written twice: 'it''s'.
      if (text[index + 1] === "'") index += 1;
      else inString = false;
      continue;
    }
    if (char === "'") inString = true;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth < 0) return undefined;
    } else if (depth === 0 && text.startsWith(operator, index)) {
      parts.push(text.slice(start, index));
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (inString || depth !== 0) return undefined;
  parts.push(text.slice(start));
  return parts;
}

/** The text without parentheses that enclose all of it, e.g. `((a && b))` becomes `a && b`. */
function stripEnclosingParens(text: string): string {
  let current = text.trim();
  while (current.startsWith('(') && current.endsWith(')')) {
    const inner = current.slice(1, -1);
    // `(a) && (b)` starts and ends with parentheses that do not enclose the whole text.
    if (splitTopLevel(inner, '&&') === undefined) return current;
    current = inner.trim();
  }
  return current;
}

/** A conjunct with its whitespace collapsed and its comparison operators spaced one way. */
const normalize = (conjunct: string): string =>
  conjunct
    .replace(/\s+/g, ' ')
    .replace(/\s*(==|!=)\s*/g, ' $1 ')
    .trim();

/**
 * The conjuncts of an expression. A disjunction is one opaque clause when nested inside a
 * conjunction, but makes the whole condition undefined at the top, where nothing is required.
 */
function conjunctsOf(text: string, topLevel: boolean): string[] | undefined {
  const stripped = stripEnclosingParens(text);
  if (stripped === '') return undefined;
  const disjuncts = splitTopLevel(stripped, '||');
  if (disjuncts === undefined) return undefined;
  if (disjuncts.length > 1) return topLevel ? undefined : [normalize(text)];
  const parts = splitTopLevel(stripped, '&&');
  if (parts === undefined) return undefined;
  if (parts.length === 1) return [normalize(stripped)];
  const nested = parts.map((part) => conjunctsOf(part, false));
  return nested.every((part): part is string[] => part !== undefined) ? nested.flat() : undefined;
}

/**
 * The clauses a job `if:` requires all of: its top-level `&&` operands, nested parenthesised
 * conjunctions flattened, whitespace normalised. Undefined when the condition is not a plain
 * conjunction (a top-level `||`, unbalanced parentheses or quotes, or `${{ }}` mixed with text),
 * because no single clause of such a condition is guaranteed to hold.
 */
export function requiredClauses(condition: string): string[] | undefined {
  let expression = condition.trim();
  const wrapped = WRAPPED_EXPRESSION.exec(expression);
  if (wrapped?.[1] !== undefined) expression = wrapped[1];
  if (expression.includes('${{') || expression.includes('}}')) return undefined;
  return conjunctsOf(expression, true);
}
