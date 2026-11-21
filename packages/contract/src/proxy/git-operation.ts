// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** What a smart-HTTP request does to a repository. */
export const GitOperation = z.enum(['read', 'write']).meta({
  id: 'GitOperation',
  title: 'Git operation',
  description:
    'What a git client asks to do to a repository through the gateway; Authorizer.authorize() decides each per principal and repository.',
  enumDescriptions: {
    read: 'Clone or fetch: GET info/refs?service=git-upload-pack and POST git-upload-pack.',
    write: 'Push: GET info/refs?service=git-receive-pack and POST git-receive-pack.',
  },
  examples: ['read', 'write'],
});

/** A git operation, inferred from {@link GitOperation}. */
export type GitOperation = z.infer<typeof GitOperation>;

/** The smart-HTTP endpoint a request reached. */
export const SmartHttpEndpoint = z.enum(['info-refs', 'upload-pack', 'receive-pack']).meta({
  id: 'SmartHttpEndpoint',
  title: 'Smart-HTTP endpoint',
  description: 'Which of the three git smart-HTTP endpoints of /<repo>.git a request reached.',
  enumDescriptions: {
    'info-refs':
      'GET /<repo>.git/info/refs?service=…: the ref advertisement (or the protocol v2 capabilities).',
    'upload-pack': 'POST /<repo>.git/git-upload-pack: fetch negotiation and the pack sent to the client.',
    'receive-pack':
      'POST /<repo>.git/git-receive-pack: ref update commands and the pack pushed by the client.',
  },
  examples: ['receive-pack'],
});

/** A smart-HTTP endpoint, inferred from {@link SmartHttpEndpoint}. */
export type SmartHttpEndpoint = z.infer<typeof SmartHttpEndpoint>;
