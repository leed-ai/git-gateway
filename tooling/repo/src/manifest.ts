// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const DependencyMap = z.record(
  z.string().min(1).describe('npm package name, e.g. "zod" or "@leed-ai/git-gateway-core".'),
  z
    .string()
    .describe(
      'What to install: a semver range ("^4"), an exact version, a dist-tag, or a protocol spec ("workspace:*").',
    ),
);

/** The parts of a package.json the repository tools use; every other field is kept as it is. */
export const PackageManifest = z
  .looseObject({
    name: z.string().min(1).optional().describe('npm package name; absent only on a nameless root manifest.'),
    version: z
      .string()
      .min(1)
      .optional()
      .describe('Semver version of the package; required for a public package.'),
    private: z
      .boolean()
      .optional()
      .describe(
        'true for a package that is never published (the root, tooling, examples); absent means public.',
      ),
    workspaces: z
      .array(z.string().min(1).describe('A glob of workspace package directories, e.g. "packages/*".'))
      .optional()
      .describe('Workspace globs, on the root manifest only.'),
    dependencies: DependencyMap.optional().describe('Runtime dependencies installed with the package.'),
    devDependencies: DependencyMap.optional().describe(
      'Dependencies for building and testing; never installed by consumers.',
    ),
    peerDependencies: DependencyMap.optional().describe(
      'Dependencies the host application supplies, one shared copy.',
    ),
    optionalDependencies: DependencyMap.optional().describe(
      'Runtime dependencies whose install may fail without failing the package.',
    ),
    peerDependenciesMeta: z
      .record(
        z.string().min(1).describe('Name of a declared peer dependency.'),
        z
          .object({
            optional: z
              .boolean()
              .optional()
              .describe('true when only part of the package needs the peer; absent means required.'),
          })
          .describe('Settings for one peer dependency.'),
      )
      .optional()
      .describe('Per-peer settings, keyed by peer name.'),
  })
  .meta({
    id: 'PackageManifest',
    title: 'Package manifest',
    description: 'The fields of a package.json read by the dependency policy, SPDX and release tools.',
    examples: [{ name: '@leed-ai/git-gateway-core', version: '0.0.0', peerDependencies: { zod: '^4' } }],
  });

/** A parsed package.json, inferred from {@link PackageManifest}. */
export type PackageManifest = z.infer<typeof PackageManifest>;

/** The dependency fields of a package.json that the repository tools read and write. */
export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** A workspace package: its directory relative to the repository root and its manifest. */
export interface WorkspacePackage {
  readonly dir: string;
  readonly manifest: PackageManifest;
}

/** True when the package is published to npm (not marked private). */
export const isPublic = (manifest: PackageManifest): boolean => manifest.private !== true;
