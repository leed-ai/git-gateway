// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { Role } from './principal.ts';

/** A glob over fully qualified branch or tag refs. */
export const RefPattern = z
  .string()
  .min(12)
  .max(266)
  .regex(
    new RegExp(
      String.raw`^refs/(?:heads|tags)/(?!.*\.\.)(?!.*//)(?!.*/$)(?!.*\*{3})[^\x00-\x20\x7f~^:?[\\]+$`,
    ),
  )
  .meta({
    id: 'RefPattern',
    title: 'Ref pattern',
    description:
      'A glob matched against a whole fully qualified ref under refs/heads/ or refs/tags/: "*" matches any run of characters inside one path component (never "/"), "**" matches any run including "/", everything else matches itself. No "..", "//", trailing "/", whitespace, control characters, ~ ^ : ? [ or backslash; 12–266 characters.',
    examples: ['refs/heads/main', 'refs/heads/release/*', 'refs/tags/**'],
  });

/** A ref glob, inferred from {@link RefPattern}. */
export type RefPattern = z.infer<typeof RefPattern>;

const subjectName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\n\0]+$/)
  .describe('A principal subject, compared exactly with Principal.subject.');

/** Which principals a rule lets push. */
export const PrincipalSelector = z
  .object({
    subjects: z
      .array(subjectName)
      .max(1000)
      .default([])
      .describe('Principals named by subject; at most 1000, default none.'),
    roles: z
      .array(Role)
      .max(100)
      .default([])
      .describe('Principals holding any of these roles; at most 100, default none.'),
  })
  .strict()
  .meta({
    id: 'PrincipalSelector',
    title: 'Principal selector',
    description:
      'Selects principals by subject or role: a principal matches when its subject is listed or it holds any listed role. With both lists empty it matches nobody.',
    examples: [{ subjects: ['user:42'], roles: ['maintainer'] }],
  });

/** A principal selector as written (defaults optional). */
export type PrincipalSelectorInput = z.input<typeof PrincipalSelector>;
/** A principal selector, inferred from {@link PrincipalSelector}. */
export type PrincipalSelector = z.output<typeof PrincipalSelector>;

const pushers = PrincipalSelector.nullable()
  .default(null)
  .describe(
    'Who may update matching refs at all; null (the default) lets every principal the Authorizer allowed to write.',
  );

/** What the rule-based branch policy allows on refs no rule matches. */
export const BranchPermissions = z
  .object({
    pushers,
    create: z.boolean().default(true).describe('Whether a push may create a ref; default true.'),
    delete: z.boolean().default(true).describe('Whether a push may delete a ref; default true.'),
    forcePush: z
      .boolean()
      .default(false)
      .describe(
        'Whether a push may move a branch to a commit that does not contain its current head (a non-fast-forward, "git push --force") or move an existing tag; default false.',
      ),
  })
  .strict()
  .meta({
    id: 'BranchPermissions',
    title: 'Branch permissions',
    description:
      'What the rule-based branch policy allows on a ref no rule matches. Defaults: anyone with write access, create and delete allowed, force pushes refused.',
    examples: [{ pushers: null, create: true, delete: true, forcePush: false }],
  });

/** Branch permissions as written (defaults optional). */
export type BranchPermissionsInput = z.input<typeof BranchPermissions>;
/** Branch permissions, inferred from {@link BranchPermissions}. */
export type BranchPermissions = z.output<typeof BranchPermissions>;

/** One rule of the rule-based branch policy. */
export const BranchRule = z
  .object({
    pattern: RefPattern.describe('The refs this rule governs.'),
    pushers,
    create: z.boolean().default(true).describe('Whether a push may create a matching ref; default true.'),
    delete: z
      .boolean()
      .default(false)
      .describe('Whether a push may delete a matching ref; default false (rules usually protect).'),
    forcePush: z
      .boolean()
      .default(false)
      .describe(
        'Whether a push may move a matching branch to a commit that does not contain its current head, or move a matching tag; default false.',
      ),
    message: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\n\0]+$/)
      .nullable()
      .default(null)
      .describe(
        'Text git shows the user when this rule refuses an update, e.g. "main is protected"; one line of 1–200 characters. Null (the default) uses a message naming the ref and what was refused.',
      ),
  })
  .strict()
  .meta({
    id: 'BranchRule',
    title: 'Branch rule',
    description:
      'Governs the refs matching `pattern`: who may push them, whether they may be created or deleted, and whether force pushes are allowed. Rules are tried in order and the first match decides.',
    examples: [
      {
        pattern: 'refs/heads/main',
        pushers: { subjects: [], roles: ['maintainer'] },
        create: true,
        delete: false,
        forcePush: false,
        message: 'main is protected',
      },
    ],
  });

/** A branch rule as written (defaults optional). */
export type BranchRuleInput = z.input<typeof BranchRule>;
/** A branch rule, inferred from {@link BranchRule}. */
export type BranchRule = z.output<typeof BranchRule>;

/** Configuration of the rule-based branch policy. */
export const BranchPolicyConfig = z
  .object({
    rules: z
      .array(BranchRule)
      .max(200)
      .default([])
      .describe(
        'Rules tried in order; the first whose pattern matches a ref decides it. At most 200, default none.',
      ),
    fallback: BranchPermissions.default({
      pushers: null,
      create: true,
      delete: true,
      forcePush: false,
    }).describe(
      'What applies to a branch or tag ref no rule matches; default anyone with write access, create and delete allowed, force refused.',
    ),
  })
  .strict()
  .meta({
    id: 'BranchPolicyConfig',
    title: 'Branch policy configuration',
    description:
      'Configuration of the reference rule-based BranchPolicy. Refs outside refs/heads/ and refs/tags/ are always refused, whatever the rules say.',
    examples: [
      {
        rules: [
          {
            pattern: 'refs/heads/main',
            pushers: { subjects: [], roles: ['maintainer'] },
            create: true,
            delete: false,
            forcePush: false,
            message: 'main is protected',
          },
        ],
        fallback: { pushers: null, create: true, delete: true, forcePush: false },
      },
    ],
  });

/** A branch policy configuration as written (defaults optional). */
export type BranchPolicyConfigInput = z.input<typeof BranchPolicyConfig>;
/** A branch policy configuration, inferred from {@link BranchPolicyConfig}. */
export type BranchPolicyConfig = z.output<typeof BranchPolicyConfig>;
