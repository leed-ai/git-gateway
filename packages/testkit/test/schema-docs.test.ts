// SPDX-License-Identifier: Apache-2.0
import { schemaDocumentationSuite } from '@leed-ai/git-gateway-schema-docs/suite';

schemaDocumentationSuite(import.meta.glob(['../src/**/*.ts', '!../src/**/*.test.ts'], { eager: true }));
