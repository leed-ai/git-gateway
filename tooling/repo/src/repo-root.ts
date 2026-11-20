// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';

/** The repository root, three directories above tooling/repo/src. */
export const REPO_ROOT: string = resolve(import.meta.dirname, '../../..');
