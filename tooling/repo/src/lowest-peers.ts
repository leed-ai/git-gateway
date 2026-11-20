// SPDX-License-Identifier: Apache-2.0
import type { PackageManifest } from './manifest.ts';
import { PEER_POLICY } from './peer-policy.ts';
import { lowestVersionOf } from './version-range.ts';

/**
 * Returns the manifest with each policy peer it installs as a devDependency pinned to the
 * lowest version its declared range admits, for the nightly lowest-supported-version leg.
 */
export function pinLowestPeers(manifest: PackageManifest): PackageManifest {
  const devDependencies = { ...manifest.devDependencies };
  let changed = false;
  for (const [peer, policyRange] of Object.entries(PEER_POLICY)) {
    if (devDependencies[peer] === undefined) continue;
    const lowest = lowestVersionOf(manifest.peerDependencies?.[peer] ?? policyRange);
    if (lowest === undefined) throw new Error(`cannot find the lowest version of ${peer}`);
    devDependencies[peer] = lowest;
    changed = true;
  }
  return changed ? { ...manifest, devDependencies } : manifest;
}
