// SPDX-License-Identifier: Apache-2.0
import { isPublic, type PackageManifest, type WorkspacePackage } from './manifest.ts';

/** A package that will be published at its current version. */
export interface PublishTarget {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
}

/** Manifest fields whose packages a consumer installs alongside this one; devDependencies never are. */
const INSTALLED_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** The names of every package a manifest needs installed beside it. */
const installedDependencies = (manifest: PackageManifest): string[] =>
  INSTALLED_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {}));

/**
 * Orders packages so each comes after every package in the list it depends on (dependencies,
 * peerDependencies, optionalDependencies), keeping the given order where nothing constrains it.
 * Throws on a dependency cycle, which no publish order can satisfy.
 */
export function orderByDependencies(packages: readonly WorkspacePackage[]): WorkspacePackage[] {
  const byName = new Map(
    packages.flatMap((pkg) => (pkg.manifest.name === undefined ? [] : [[pkg.manifest.name, pkg]])),
  );
  const ordered: WorkspacePackage[] = [];
  const done = new Set<WorkspacePackage>();
  const visiting: string[] = [];
  const visit = (pkg: WorkspacePackage): void => {
    if (done.has(pkg)) return;
    const label = pkg.manifest.name ?? pkg.dir;
    if (visiting.includes(label)) {
      throw new Error(
        `dependency cycle between packages: ${[...visiting.slice(visiting.indexOf(label)), label].join(' -> ')}`,
      );
    }
    visiting.push(label);
    for (const name of installedDependencies(pkg.manifest)) {
      const dependency = byName.get(name);
      if (dependency !== undefined && dependency !== pkg) visit(dependency);
    }
    visiting.pop();
    done.add(pkg);
    ordered.push(pkg);
  };
  packages.forEach(visit);
  return ordered;
}

/**
 * The public workspace packages whose current version is not on the registry yet, in publish
 * order: an internal package always goes out before the packages that depend on it, so a
 * dependent never goes live pointing at a version the registry does not have.
 */
export function planPublish(
  packages: readonly WorkspacePackage[],
  isPublished: (name: string, version: string) => boolean,
): PublishTarget[] {
  const publicPackages = packages.filter(({ dir, manifest }) => dir !== '.' && isPublic(manifest));
  return orderByDependencies(publicPackages).flatMap(({ dir, manifest }) => {
    const { name, version } = manifest;
    if (name === undefined || version === undefined)
      throw new Error(`${dir}: package.json needs a name and version`);
    return isPublished(name, version) ? [] : [{ dir, name, version }];
  });
}
