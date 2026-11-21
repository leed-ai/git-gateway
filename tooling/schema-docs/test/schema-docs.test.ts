// SPDX-License-Identifier: Apache-2.0
import { schemaDocumentationSuite } from '../src/suite.ts';

schemaDocumentationSuite(import.meta.glob(['../src/**/*.ts', '!../src/suite.ts'], { eager: true }));
