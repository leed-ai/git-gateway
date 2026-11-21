// SPDX-License-Identifier: Apache-2.0
import { gatewayError, type GatewayError } from '@leed-ai/git-gateway-contract/gateway-error';

import type { GitLabProject } from './schemas/gitlab-responses.ts';

/** How existing projects are fronted by id (GitLabBackendConfig.frontedProjects, parsed). */
export interface FrontedProjectsConfig {
  readonly prefix: string;
  readonly namespace: string;
}

/**
 * The reserved names `<prefix><projectId>` of a GitLab backend's fronted projects: which names are
 * reserved, which project id each addresses, and whether a project may be fronted (it lives under
 * the fronted namespace). Ids already confirmed are remembered for the life of the backend.
 */
export class FrontedProjects {
  readonly #pattern: RegExp | undefined;
  readonly #namespace: string | undefined;
  readonly #verified = new Set<number>();

  constructor(config: FrontedProjectsConfig | undefined) {
    this.#namespace = config?.namespace.toLowerCase();
    this.#pattern =
      config === undefined
        ? undefined
        : new RegExp(`^${config.prefix.replace(/[.]/g, '\\.')}([1-9][0-9]{0,15})$`);
  }

  /** The project id `repo` addresses when it is a reserved name; null for an ordinary name. */
  idOf(repo: string): number | null {
    const match = this.#pattern?.exec(repo);
    return match?.[1] === undefined ? null : Number(match[1]);
  }

  /** True once {@link admits} has accepted project `id`. */
  verified(id: number): boolean {
    return this.#verified.has(id);
  }

  /** True when `project` is project `id` and lives under the fronted namespace, at any depth; remembered. */
  admits(id: number, project: GitLabProject): boolean {
    const ok =
      this.#namespace !== undefined &&
      project.id === id &&
      project.path_with_namespace.toLowerCase().startsWith(`${this.#namespace}/`);
    if (ok) this.#verified.add(id);
    return ok;
  }
}

/** The invalid_input error createRepo and deleteRepo answer for a fronted project's reserved name. */
export function frontedLifecycleRefused(repo: string, what: 'created' | 'deleted'): GatewayError {
  return gatewayError('invalid_input', 'Invalid input', {
    issues: [
      {
        path: 'name',
        message: `${repo} addresses an existing GitLab project by id; it cannot be ${what} through the gateway`,
      },
    ],
  });
}
