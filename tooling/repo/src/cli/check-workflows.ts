// SPDX-License-Identifier: Apache-2.0
import { REPO_ROOT } from '../repo-root.ts';
import { readWorkflowFiles } from '../workflow-files.ts';
import { findWorkflowViolations } from '../workflow-policy.ts';

const files = readWorkflowFiles(REPO_ROOT);
const violations = findWorkflowViolations(files);
if (violations.length > 0) {
  for (const { path, message } of violations) console.error(`${path}: ${message}`);
  process.exit(1);
}
console.log(`Workflow policy: ${files.length} workflow and action files pass.`);
