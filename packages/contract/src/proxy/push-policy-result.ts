// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { RefDecisionAllow, RefDecisionDeny } from './policy-result.ts';

/** What a push policy asks the gateway to compute before it is called. */
export const PushPolicyNeeds = z
  .object({
    changedPaths: z
      .boolean()
      .describe(
        'true to be given, for every update, the commits it brings with the paths each changes (PushPolicyUpdate.commits). That means buffering and reading the pushed pack and reading trees from storage, bounded by SmartHttpConfig.maxPushPolicyPackBytes, maxPushPolicyObjectBytes, maxPushPolicyReads and maxChangedPaths; a push past a bound is refused as uncheckable. false to decide from the ref updates alone, before the pack is read (`commits` is then null).',
      ),
  })
  .strict()
  .meta({
    id: 'PushPolicyNeeds',
    title: 'Push policy needs',
    description:
      'What PushPolicy.needs() returns for a push: whether check() needs the changed paths of every update.',
    examples: [{ changedPaths: true }],
  });

/** What a push policy needs, inferred from {@link PushPolicyNeeds}. */
export type PushPolicyNeeds = z.infer<typeof PushPolicyNeeds>;

/** A push policy's verdict on one ref update: allow or deny. */
export const PushRefDecision = z.discriminatedUnion('decision', [RefDecisionAllow, RefDecisionDeny]).meta({
  id: 'PushRefDecision',
  title: 'Push ref decision',
  description: 'The push policy verdict on one ref update: allow it, or deny it with a reason git shows.',
  examples: [
    { ref: 'refs/heads/main', decision: 'deny', reason: 'generated/ is written by the build pipeline' },
  ],
});

/** A push policy's verdict on one update, inferred from {@link PushRefDecision}. */
export type PushRefDecision = z.infer<typeof PushRefDecision>;

/** What PushPolicy.check() returns. */
export const PushPolicyResult = z
  .object({
    refs: z
      .array(PushRefDecision)
      .max(10_000)
      .superRefine((decisions, ctx) => {
        const seen = new Set<string>();
        decisions.forEach((decision, index) => {
          if (seen.has(decision.ref)) {
            ctx.addIssue({
              code: 'custom',
              message: `the ref ${decision.ref} has more than one decision; a push policy result names each ref once`,
              path: [index, 'ref'],
            });
          }
          seen.add(decision.ref);
        });
      })
      .describe(
        'One decision per update the policy was given, each ref named at most once. An update without a decision is refused, and a push is written only when every update is allowed; otherwise each refused ref is reported with its reason and the rest as "not updated: another update in this push was refused".',
      ),
  })
  .strict()
  .meta({
    id: 'PushPolicyResult',
    title: 'Push policy result',
    description:
      'The push policy verdict on every ref update of one push. It runs after the branch policy, and the push is written only when both allow every update.',
    examples: [
      {
        refs: [
          {
            ref: 'refs/heads/main',
            decision: 'deny',
            reason: 'files over 10 MiB are not accepted: video.mp4',
          },
          { ref: 'refs/heads/feature/x', decision: 'allow' },
        ],
      },
    ],
  });

/** A push policy verdict, inferred from {@link PushPolicyResult}. */
export type PushPolicyResult = z.infer<typeof PushPolicyResult>;
/** A push policy verdict as a policy may write it, inferred from {@link PushPolicyResult}. */
export type PushPolicyResultInput = z.input<typeof PushPolicyResult>;
