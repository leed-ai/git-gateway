// SPDX-License-Identifier: Apache-2.0
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { z } from 'zod';

import { Bytes } from './packet.ts';

const EXAMPLE_OLD = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const EXAMPLE_NEW = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';

/**
 * A ref name as git accepts it (`git check-ref-format`): "refs/" then slash-separated components,
 * none starting with "." or ending in ".lock", without "..", "@{", "//", control characters, space,
 * DEL or any of ~ ^ : ? * [ \, and not ending in "/" or ".".
 */
export const GitRefName = z
  .string()
  .min(6)
  .max(4096)
  .regex(
    new RegExp(
      String.raw`^refs/(?!.*\.\.)(?!.*@\{)(?!.*//)(?!.*/\.)(?!.*\.lock(?:/|$))(?!.*[./]$)[^\x00-\x20\x7f~^:?*[\\]+$`,
    ),
  )
  .meta({
    id: 'GitRefName',
    title: 'Git ref name',
    description:
      'A fully qualified ref of any namespace, as a receive-pack command names it: "refs/" followed by components valid under git check-ref-format (no "..", "@{", "//", control characters, space, DEL or ~ ^ : ? * [ \\; no component starting with "." or ending with ".lock"; no trailing "/" or "."). Branch policy decides which namespaces may be pushed.',
    examples: ['refs/heads/main', 'refs/tags/v1.0.0', 'refs/notes/commits'],
  });

/** A git ref name, inferred from {@link GitRefName}. */
export type GitRefName = z.infer<typeof GitRefName>;

/** One update command of a push. */
export const ReceivePackCommand = z
  .object({
    oldSha: Sha.describe(
      'Id the client believes the ref names now; all zeros when the push creates the ref.',
    ),
    newSha: Sha.describe('Id the ref should name after the push; all zeros when the push deletes the ref.'),
    ref: GitRefName.describe('The ref to update, fully qualified.'),
  })
  .strict()
  .meta({
    id: 'ReceivePackCommand',
    title: 'receive-pack command',
    description:
      'One "<old> <new> <ref>" update command from the start of a git-receive-pack request. The server refuses it when the ref no longer names `oldSha`.',
    examples: [{ oldSha: EXAMPLE_OLD, newSha: EXAMPLE_NEW, ref: 'refs/heads/main' }],
  });

/** A receive-pack update command, inferred from {@link ReceivePackCommand}. */
export type ReceivePackCommand = z.infer<typeof ReceivePackCommand>;

/** A capability token: no whitespace or NUL. */
export const Capability = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^[^\s\0]+$/)
  .meta({
    id: 'Capability',
    title: 'Capability',
    description:
      'One protocol capability token as the client sent it, e.g. "report-status", "side-band-64k", "push-options" or "agent=git/2.43.0": 1–1000 characters without whitespace or NUL.',
    examples: ['report-status', 'agent=git/2.43.0'],
  });

/** A push option: one line of text. */
export const PushOption = z
  .string()
  .max(65_515)
  .regex(/^[^\n\0]*$/)
  .meta({
    id: 'PushOption',
    title: 'Push option',
    description:
      'One "git push -o <option>" value: a single line of at most 65515 characters without newline or NUL. May be empty.',
    examples: ['ci.skip', 'merge_request.create'],
  });

/**
 * The update commands of a push: 1–10000, each ref named at most once. Shared by the parsed
 * request and the request the gateway sends, so both enforce the same rule.
 */
export const ReceivePackCommands = z
  .array(ReceivePackCommand)
  .min(1)
  .max(10_000)
  .refine((commands) => new Set(commands.map((command) => command.ref)).size === commands.length, {
    message: 'a ref may be named by at most one command',
  })
  .meta({
    id: 'ReceivePackCommands',
    title: 'receive-pack commands',
    description:
      'The update commands of a git-receive-pack request in the order sent: 1–10000 commands, each ref named by at most one of them.',
    examples: [[{ oldSha: EXAMPLE_OLD, newSha: EXAMPLE_NEW, ref: 'refs/heads/main' }]],
  });

/** The update commands of a push, inferred from {@link ReceivePackCommands}. */
export type ReceivePackCommands = z.infer<typeof ReceivePackCommands>;

/** The leading part of a git-receive-pack request: everything before the pack. */
export const ReceivePackRequest = z
  .object({
    commands: ReceivePackCommands.describe(
      'The update commands in the order sent; 1–10000, each ref at most once.',
    ),
    capabilities: z
      .array(Capability)
      .max(100)
      .describe('Capabilities the client requested on the first command, in the order sent; may be empty.'),
    pushOptions: z
      .array(PushOption)
      .max(100)
      .describe(
        'Push options sent after the commands, in order; empty when the "push-options" capability was not requested.',
      ),
    shallow: z
      .array(Sha.describe('Id of a shallow boundary commit the client holds.'))
      .max(10_000)
      .describe(
        '"shallow <id>" lines sent before the commands by a client pushing from a shallow clone; usually empty.',
      ),
  })
  .strict()
  .meta({
    id: 'ReceivePackRequest',
    title: 'receive-pack request head',
    description:
      'The leading part of a protocol v0/v1 git-receive-pack request body, before the pack: shallow lines, update commands with the capabilities on the first, and push options.',
    examples: [
      {
        commands: [{ oldSha: EXAMPLE_OLD, newSha: EXAMPLE_NEW, ref: 'refs/heads/main' }],
        capabilities: ['report-status', 'side-band-64k', 'agent=git/2.43.0'],
        pushOptions: [],
        shallow: [],
      },
    ],
  });

/** The head of a receive-pack request, inferred from {@link ReceivePackRequest}. */
export type ReceivePackRequest = z.infer<typeof ReceivePackRequest>;

/** What to send in a git-receive-pack request the gateway makes itself. */
export const ReceivePackPush = z
  .object({
    commands: ReceivePackCommands.describe(
      'The update commands to send, in order; 1–10000, each ref at most once.',
    ),
    capabilities: z
      .array(Capability)
      .max(100)
      .default(['report-status'])
      .describe(
        'Capabilities to request on the first command; default ["report-status"]. "push-options" is added automatically when push options are given.',
      ),
    pushOptions: z
      .array(PushOption)
      .max(100)
      .default([])
      .describe('Push options to send after the commands; default none.'),
    pack: Bytes.optional().describe(
      'The pack holding the objects the commands need, as written by writePack. Absent: no pack is sent, which is right only when every command deletes a ref.',
    ),
  })
  .strict()
  .refine(
    (push) => push.pack !== undefined || push.commands.every((command) => /^0{40}$/.test(command.newSha)),
    { message: 'a pack is required unless every command deletes a ref', path: ['pack'] },
  )
  .meta({
    id: 'ReceivePackPush',
    title: 'receive-pack push',
    description:
      'A git-receive-pack request the gateway sends to a storage backend: update commands, capabilities, push options and the pack.',
    examples: [
      {
        commands: [
          { oldSha: EXAMPLE_OLD, newSha: '0000000000000000000000000000000000000000', ref: 'refs/heads/old' },
        ],
        capabilities: ['report-status'],
        pushOptions: [],
      },
    ],
  });

/** A push to send, as accepted (defaults optional). */
export type ReceivePackPushInput = z.input<typeof ReceivePackPush>;
