// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { FullRefName } from '../schemas/names.ts';

const policyReason = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[^\n\0]+$/)
  .describe(
    'Why the update is or would be refused, shown to the user by git as "! [remote rejected] <ref> (<reason>)": one line of 1–500 characters.',
  );

/** The policy allows any update of the ref, force pushes included. */
export const RefDecisionAllow = z
  .object({
    ref: FullRefName.describe('The ref the update names.'),
    decision: z.literal('allow').describe('The update may proceed, whether or not it is a fast-forward.'),
  })
  .strict()
  .meta({
    id: 'RefDecisionAllow',
    title: 'Ref decision: allow',
    description: 'The branch policy allows this update as it stands, force pushes included.',
    examples: [{ ref: 'refs/heads/feature/x', decision: 'allow' }],
  });

/** The policy allows the update only if it is a fast-forward. */
export const RefDecisionFastForwardOnly = z
  .object({
    ref: FullRefName.describe('The ref the update names.'),
    decision: z
      .literal('fast-forward-only')
      .describe(
        'The update may proceed only if the new commit contains the current head; the gateway checks ancestry and refuses otherwise. A creation (no current head) proceeds; a deletion (no new commit) is refused.',
      ),
    reason: policyReason,
  })
  .strict()
  .meta({
    id: 'RefDecisionFastForwardOnly',
    title: 'Ref decision: fast-forward only',
    description:
      'The branch policy allows this update only as a fast-forward. The gateway proves the new commit descends from the old one (from the pushed pack and the backend) and refuses with `reason` when it does not or cannot be shown to. Creating a ref is allowed (there is no old head to lose); deleting one is refused with `reason` (there is no new commit to contain the old head). Moving an existing tag is never a fast-forward.',
    examples: [
      {
        ref: 'refs/heads/main',
        decision: 'fast-forward-only',
        reason: 'force pushes to main are not allowed',
      },
    ],
  });

/** The policy refuses the update. */
export const RefDecisionDeny = z
  .object({
    ref: FullRefName.describe('The ref the update names.'),
    decision: z.literal('deny').describe('The update is refused.'),
    reason: policyReason,
  })
  .strict()
  .meta({
    id: 'RefDecisionDeny',
    title: 'Ref decision: deny',
    description: 'The branch policy refuses this update; git shows `reason` to the user.',
    examples: [{ ref: 'refs/heads/main', decision: 'deny', reason: 'main is protected' }],
  });

/** The branch policy's verdict on one ref update. */
export const RefDecision = z
  .discriminatedUnion('decision', [RefDecisionAllow, RefDecisionFastForwardOnly, RefDecisionDeny])
  .meta({
    id: 'RefDecision',
    title: 'Ref decision',
    description: 'The branch policy verdict on one ref update, discriminated by `decision`.',
    examples: [{ ref: 'refs/heads/main', decision: 'deny', reason: 'main is protected' }],
  });

/** A verdict on one ref update, inferred from {@link RefDecision}. */
export type RefDecision = z.infer<typeof RefDecision>;

/** What BranchPolicy.check() returns for a push. */
export const PolicyResult = z
  .object({
    refs: z
      .array(RefDecision)
      .max(10_000)
      .superRefine((decisions, ctx) => {
        const seen = new Set<string>();
        decisions.forEach((decision, index) => {
          if (seen.has(decision.ref)) {
            ctx.addIssue({
              code: 'custom',
              message: `the ref ${decision.ref} has more than one decision; a policy result names each ref once`,
              path: [index, 'ref'],
            });
          }
          seen.add(decision.ref);
        });
      })
      .describe(
        'One decision per update the policy was given, for the same refs, each ref named at most once (a result naming a ref twice is refused, so the gateway never has to pick between conflicting decisions). A push is forwarded only when every update is allowed; an update without a decision is refused.',
      ),
  })
  .strict()
  .meta({
    id: 'PolicyResult',
    title: 'Policy result',
    description:
      'The branch policy verdict on every ref update of one push. The gateway forwards the push only when all of them are allowed (fast-forward-only ones after their ancestry is proven); otherwise nothing is written and git reports each refused ref with its reason.',
    examples: [
      {
        refs: [
          {
            ref: 'refs/heads/main',
            decision: 'fast-forward-only',
            reason: 'force pushes to main are not allowed',
          },
          { ref: 'refs/tags/v1.0.0', decision: 'deny', reason: 'tags are created by the release pipeline' },
        ],
      },
    ],
  });

/** A branch policy verdict, inferred from {@link PolicyResult}. */
export type PolicyResult = z.infer<typeof PolicyResult>;
