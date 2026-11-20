// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';

import { findPolicyViolations } from '../dependency-policy.ts';
import { shippedSourceImports } from '../package-imports.ts';
import { REPO_ROOT } from '../repo-root.ts';
import { listWorkspacePackages } from '../workspace.ts';

const packages = listWorkspacePackages(REPO_ROOT).map((pkg) => ({
  ...pkg,
  sourceImports: pkg.dir === '.' ? new Set<string>() : shippedSourceImports(join(REPO_ROOT, pkg.dir)),
}));
const violations = findPolicyViolations(packages);
if (violations.length > 0) {
  for (const { dir, message } of violations) console.error(`${dir}/package.json: ${message}`);
  console.error(`\n${violations.length} dependency policy violation(s). See docs/design.md, Dependencies.`);
  process.exit(1);
}
console.log(`Dependency policy: ${packages.length} package manifests pass.`);
