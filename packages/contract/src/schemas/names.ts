// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { Sha } from './sha.ts';

/**
 * One or more slash-separated ref components following `git check-ref-format`: no component starts
 * with "." or ends with ".lock", no "..", "@{", "//", control characters, space, ~ ^ : ? * [ or \,
 * not "@" alone, and no trailing "/" or ".".
 */
const REF_COMPONENTS = String.raw`(?!@$)(?!.*\.\.)(?!.*@\{)(?!.*//)(?!.*/\.)(?!.*\.lock(?:/|$))(?!.*[./]$)[^\x00-\x20\x7f~^:?*[\\.\-/][^\x00-\x20\x7f~^:?*[\\]*`;

/** A repository name: one URL path segment, served as `/<name>.git`. */
export const RepoName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((name) => !name.toLowerCase().endsWith('.git'), { message: 'must not end with ".git"' })
  .meta({
    id: 'RepoName',
    title: 'Repository name',
    description:
      'Name of a repository behind the gateway: 1–100 characters of letters, digits, ".", "_" and "-", starting with a letter or digit and not ending in ".git". Served at /<name>.git.',
    examples: ['acme-raw-content', 'site.example'],
  });

/** A repository name, inferred from {@link RepoName}. */
export type RepoName = z.infer<typeof RepoName>;

/** A short branch name such as `main` or `feature/x` (never `refs/heads/…`). */
export const BranchName = z
  .string()
  .min(1)
  .max(255)
  .regex(new RegExp(`^(?!refs/)(?!HEAD$)(?![0-9a-f]{40}$)${REF_COMPONENTS}$`))
  .meta({
    id: 'BranchName',
    title: 'Branch name',
    description:
      'A short branch name, 1–255 characters, valid under git check-ref-format (no "..", "@{", "//", spaces, control characters or ~ ^ : ? * [ or backslash; no component starting with "." or ending with ".lock"; not starting with "-" or "refs/"; not "HEAD"; not 40 lowercase hex characters, which a Revision always reads as a commit id). The gateway stores it as refs/heads/<name>.',
    examples: ['main', 'staging', 'feature/new-page'],
  });

/** A short branch name, inferred from {@link BranchName}. */
export type BranchName = z.infer<typeof BranchName>;

/** A fully qualified ref under `refs/heads/` or `refs/tags/`. */
export const FullRefName = z
  .string()
  .min(11)
  .max(266)
  .regex(new RegExp(`^refs/(?:heads|tags)/${REF_COMPONENTS}$`))
  .meta({
    id: 'FullRefName',
    title: 'Full ref name',
    description:
      'A fully qualified ref, "refs/heads/<branch>" or "refs/tags/<tag>", where the name after the prefix follows the same rules as a branch name.',
    examples: ['refs/heads/main', 'refs/tags/v1.0.0'],
  });

/** A fully qualified ref, inferred from {@link FullRefName}. */
export type FullRefName = z.infer<typeof FullRefName>;

/** What a read is made against: a commit id or a branch name. */
export const Revision = z
  .union([
    Sha.describe(
      'A commit id. Any 40-character lowercase hex string is read as a commit id, never a branch.',
    ),
    BranchName.describe('A branch name, resolved to the branch head at the time of the call.'),
  ])
  .meta({
    id: 'Revision',
    title: 'Revision',
    description:
      'What a read is made against: a 40-character lowercase hex commit id, or a short branch name resolved to its current head.',
    examples: ['main', '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a'],
  });

/** A commit id or branch name, inferred from {@link Revision}. */
export type Revision = z.infer<typeof Revision>;

/** A file path inside a repository. */
export const FilePath = z
  .string()
  .min(1)
  .max(4096)
  // Segments are capped at 255 characters, the limit a tree entry name has, so every committed path
  // can be listed back. Control characters (newline included) are excluded outright, so every lookahead sees the whole
  // string; the "s" flag keeps that true even if the character class is ever loosened. ".git" is
  // matched case-insensitively by its character classes rather than an "i" flag, because JSON Schema
  // "pattern" drops regex flags and the published schema must enforce the same rule.
  .regex(
    new RegExp(
      String.raw`^(?!\/)(?!.*\/\/)(?!.*\/$)(?!(?:.*\/)?[^/]{256})(?!(?:.*\/)?\.\.?(?:\/|$))(?!(?:.*\/)?\.[gG][iI][tT](?:\/|$))[^\x00-\x1f\x7f\\]+$`,
      's',
    ),
  )
  .meta({
    id: 'FilePath',
    title: 'File path',
    description:
      'A path inside the repository relative to its root, 1–4096 characters, "/"-separated into segments of 1–255 characters: no leading or trailing "/", no empty, "." or ".." segment, no ".git" segment (any case), no backslash and no control character (U+0000–U+001F, U+007F). Case-sensitive; unicode allowed.',
    examples: ['content/index.md', 'templates/layouts/page.hbs'],
  });

/** A file path inside a repository, inferred from {@link FilePath}. */
export type FilePath = z.infer<typeof FilePath>;

/** The key that makes a write idempotent. */
export const IdempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .meta({
    id: 'IdempotencyKey',
    title: 'Idempotency key',
    description:
      'Caller-chosen key that makes a commit idempotent: 1–128 characters of letters, digits, ".", "_", ":" and "-", starting with a letter or digit. Recorded as a "Gateway-Idempotency-Key:" trailer; a retried commit carrying a key already in the branch\'s recent history returns that commit instead of writing another.',
    examples: ['cms:publish:2f9c1e', '6f1d2c3b-9a8e-4f7d-b6c5-a4e3d2c1b0a9'],
  });

/** An idempotency key, inferred from {@link IdempotencyKey}. */
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;
