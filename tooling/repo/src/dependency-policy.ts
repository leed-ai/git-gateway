// SPDX-License-Identifier: Apache-2.0
import { DEPENDENCY_FIELDS, type WorkspacePackage } from './manifest.ts';
import { PEER_POLICY } from './peer-policy.ts';
import { isExactVersion } from './version-range.ts';

/** A broken dependency rule, located by package directory. */
export interface PolicyViolation {
  readonly dir: string;
  readonly message: string;
}

/** A workspace package with the npm packages its shipped source (not tests) imports. */
export interface PackageWithImports extends WorkspacePackage {
  readonly sourceImports: ReadonlySet<string>;
}

function checkPackage({ dir, manifest, sourceImports }: PackageWithImports): string[] {
  const problems: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (isExactVersion(spec)) problems.push(`${field}.${name} is exact-pinned to "${spec}"; use a range`);
    }
  }
  for (const [peer, range] of Object.entries(PEER_POLICY)) {
    for (const field of ['dependencies', 'optionalDependencies'] as const) {
      if (manifest[field]?.[peer] !== undefined) {
        problems.push(`${peer} is listed in ${field}; it must be a peer dependency (${range})`);
      }
    }
    const declared = manifest.peerDependencies?.[peer];
    if (declared !== undefined && declared !== range) {
      problems.push(`peerDependencies.${peer} is "${declared}"; the policy range is "${range}"`);
    }
    if (dir !== '.' && sourceImports.has(peer) && declared === undefined) {
      problems.push(`source imports ${peer} but peerDependencies does not declare it (${range})`);
    }
    if (declared !== undefined && manifest.devDependencies?.[peer] === undefined) {
      problems.push(`peer ${peer} is not a devDependency, so tests would not install the latest version`);
    }
  }
  for (const name of Object.keys(manifest.peerDependenciesMeta ?? {})) {
    if (manifest.peerDependencies?.[name] === undefined) {
      problems.push(`peerDependenciesMeta names ${name}, which is not a peer dependency`);
    }
  }
  return problems;
}

/**
 * Checks every package against the dependency policy: zod, hono and cloudflare are peer
 * dependencies declared by their policy range, never in `dependencies`, and no
 * dependency anywhere is pinned to an exact version.
 */
export function findPolicyViolations(packages: readonly PackageWithImports[]): PolicyViolation[] {
  return packages.flatMap((pkg) => checkPackage(pkg).map((message) => ({ dir: pkg.dir, message })));
}
