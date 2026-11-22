// SPDX-License-Identifier: Apache-2.0
// The hand-off between the job that builds and packs the packages and the job that publishes them.
// The publishing job holds the npm OIDC credential and runs without `bun install`, so this module
// and everything the publish and release scripts import must use Node builtins only: no zod.

/** The file the pack step writes beside the tarballs, and the publish step reads. */
export const PACKED_PLAN_FILE = 'plan.json';

/** One packed tarball, waiting to be published. */
export interface PackedPackage {
  /** Workspace directory, e.g. `packages/core`; the release step reads its CHANGELOG.md. */
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  /** The tarball's file name inside the plan's directory; never a path. */
  readonly tarball: string;
}

/** Every tarball to publish, in publish order, and the dist-tag they go out under. */
export interface PackedPlan {
  readonly tag: string;
  readonly packages: readonly PackedPackage[];
}

/** Options for one `npm publish` of a packed tarball. */
export interface PublishOptions {
  readonly tarball: string;
  readonly tag: string;
  readonly provenance: boolean;
  readonly dryRun: boolean;
}

const DIST_TAG = /^[a-z][a-z0-9-]*$/;
const PACKAGE_NAME = /^@leed-ai\/git-gateway-[a-z0-9][a-z0-9-]*$/;
const PACKAGE_DIR = /^packages\/[a-z0-9][a-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TARBALL = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Throws unless the dist-tag is lower-case letters, digits and hyphens, starting with a letter. */
export function assertDistTag(tag: string): string {
  if (!DIST_TAG.test(tag)) throw new Error(`invalid dist-tag "${tag}"`);
  return tag;
}

function field(
  entry: Readonly<Record<string, unknown>>,
  key: string,
  pattern: RegExp,
  index: number,
): string {
  const value = entry[key];
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`plan package ${index}: invalid ${key} ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Parses and validates a plan read from the pack step's artifact. Names must be this repository's
 * packages and tarballs bare file names, so a tampered plan cannot point npm at another path.
 */
export function parsePackedPlan(value: unknown): PackedPlan {
  if (!isRecord(value) || typeof value['tag'] !== 'string' || !Array.isArray(value['packages'])) {
    throw new Error('plan must be an object with a tag and a packages list');
  }
  const tag = assertDistTag(value['tag']);
  const packages = value['packages'].map((entry: unknown, index): PackedPackage => {
    if (!isRecord(entry)) throw new Error(`plan package ${index}: not an object`);
    return {
      dir: field(entry, 'dir', PACKAGE_DIR, index),
      name: field(entry, 'name', PACKAGE_NAME, index),
      version: field(entry, 'version', VERSION, index),
      tarball: field(entry, 'tarball', TARBALL, index),
    };
  });
  const names = packages.map(({ name }) => name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) throw new Error(`plan lists ${duplicate} twice`);
  return { tag, packages };
}

/**
 * Arguments for `npm publish` of a tarball packed by `bun pm pack` (which resolves workspace: ranges).
 * Provenance is always stated as a flag: a command-line flag overrides `publishConfig.provenance`,
 * so a laptop publish can turn it off where no CI identity exists to sign it.
 */
export function publishArguments({ tarball, tag, provenance, dryRun }: PublishOptions): string[] {
  return [
    'publish',
    tarball,
    '--access',
    'public',
    '--tag',
    assertDistTag(tag),
    provenance ? '--provenance' : '--provenance=false',
    ...(dryRun ? ['--dry-run'] : []),
  ];
}

/** The git tag and GitHub release name for a published version, as Changesets writes it. */
export const releaseTag = ({ name, version }: Pick<PackedPackage, 'name' | 'version'>): string =>
  `${name}@${version}`;

/**
 * The body of one version's section in a Changesets CHANGELOG.md: everything after its
 * `## <version>` heading up to the next `## ` heading. Undefined when the version has no section.
 */
export function changelogSection(markdown: string, version: string): string | undefined {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}
