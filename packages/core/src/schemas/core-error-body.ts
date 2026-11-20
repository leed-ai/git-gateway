// SPDX-License-Identifier: Apache-2.0
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { z } from 'zod';

const message = z.string().min(1).describe('Human-readable explanation of the failure.');

/** Builds one error variant: a code literal, a message and typed details. */
function variant<const Code extends string, Shape extends z.ZodRawShape>(
  code: Code,
  meaning: string,
  details: Shape,
  example: { message: string; details: z.input<z.ZodObject<Shape>> },
) {
  return z
    .object({
      code: z.literal(code).describe(meaning),
      message,
      details: z.object(details).strict().describe(`Machine-readable facts about the ${code} error.`),
    })
    .strict()
    .meta({
      id: `CoreError.${code}`,
      title: `${code} core error`,
      description: meaning,
      examples: [{ code, ...example }],
    });
}

const offset = z
  .int()
  .min(0)
  .describe('Byte offset from the start of the input at which the problem was found.');
const reason = z.string().min(1).describe('What exactly is wrong.');

/** The input is not valid pkt-line framing. */
export const MalformedPktLineError = variant(
  'malformed_pkt_line',
  'The bytes are not valid pkt-line framing: a bad length header, a length below 4 that is not a special packet, a packet over 65520 bytes, or input that ends inside a packet.',
  { offset, reason },
  { message: 'Bad pkt-line length', details: { offset: 0, reason: 'length header "zzzz" is not hex' } },
);

/** The pkt-lines are well framed but do not form a valid git protocol message. */
export const MalformedRequestError = variant(
  'malformed_request',
  'The pkt-lines are well framed but are not a valid git protocol message: a bad receive-pack command, a missing flush, or a bad report-status line.',
  { reason },
  { message: 'Malformed receive-pack command', details: { reason: 'old id is not 40 hex characters' } },
);

/** The request uses a protocol feature the gateway does not support. */
export const UnsupportedRequestError = variant(
  'unsupported_request',
  'The request uses a git protocol feature the gateway does not support, such as signed pushes or SHA-256 repositories.',
  {
    feature: z
      .string()
      .min(1)
      .describe('The unsupported feature, as git names it (e.g. "push-cert", "object-format=sha256").'),
  },
  { message: 'Signed pushes are not supported', details: { feature: 'push-cert' } },
);

/** The remote reported a fatal error in-protocol. */
export const RemoteError = variant(
  'remote_error',
  'The remote git server reported a fatal error in-protocol: an "ERR" packet or a message on side-band channel 3.',
  { remoteMessage: z.string().describe('The message the remote sent, without the trailing newline.') },
  { message: 'Remote error: access denied', details: { remoteMessage: 'access denied' } },
);

/** The kind of object that was missing or invalid. */
const objectType = z.enum(['blob', 'tree', 'commit']).meta({
  description: 'The kind of git object involved.',
  enumDescriptions: { blob: 'A file.', tree: 'A directory.', commit: 'A commit.' },
});

/** A needed object was not found in the repository. */
export const MissingObjectError = variant(
  'missing_object',
  'An object the operation needed was not found: the read callback returned null for an id that a tree or commit references.',
  { sha: Sha.describe('Id of the missing object.'), type: objectType },
  {
    message: 'Tree not found',
    details: { sha: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', type: 'tree' },
  },
);

/** An object's bytes or parsed form is not valid. */
export const InvalidObjectError = variant(
  'invalid_object',
  'An object read from the repository (or handed to an encoder) is not valid: unparsable bytes, an unknown tree mode, duplicate tree entry names, or a commit the Commit schema cannot represent.',
  {
    sha: Sha.nullable().describe('Id of the invalid object; null when it has no id yet.'),
    type: objectType,
    reason,
  },
  {
    message: 'Invalid tree object',
    details: { sha: null, type: 'tree', reason: 'unknown mode 100664' },
  },
);

/** Every error the core library reports itself, discriminated by `code`. */
export const CoreErrorBody = z
  .discriminatedUnion('code', [
    MalformedPktLineError,
    MalformedRequestError,
    UnsupportedRequestError,
    RemoteError,
    MissingObjectError,
    InvalidObjectError,
  ])
  .meta({
    id: 'CoreErrorBody',
    title: 'Core error',
    description:
      'Every error the core library reports for protocol and object problems, discriminated by `code`. Commit-action rule failures are reported as the contract GatewayError instead (path_exists, path_not_found, path_conflict).',
    examples: [
      {
        code: 'unsupported_request',
        message: 'Signed pushes are not supported',
        details: { feature: 'push-cert' },
      },
    ],
  });

/** A core error body, inferred from {@link CoreErrorBody}. */
export type CoreErrorBody = z.infer<typeof CoreErrorBody>;

/** The code of a core error. */
export type CoreErrorCode = CoreErrorBody['code'];
