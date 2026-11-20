// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { findDocumentationIssues, formatIssues } from './check.ts';
import { collectExportedSchemas } from './collect.ts';
import { buildJsonSchemaDocument } from './json-schema.ts';

/**
 * Registers the schema-documentation tests for one package. Pass the package's source
 * modules, loaded eagerly:
 *
 *   schemaDocumentationSuite(import.meta.glob(['../src/**\/*.ts', '!../src/**\/*.test.ts'], { eager: true }));
 *
 * It fails on any undocumented schema node and snapshots the generated JSON Schema, so a
 * contract change shows up in review.
 */
export function schemaDocumentationSuite(modules: Readonly<Record<string, unknown>>): void {
  describe('schema documentation', () => {
    const entries = collectExportedSchemas(modules);

    it('loads the package source modules', () => {
      expect(Object.keys(modules).length).toBeGreaterThan(0);
    });

    it('documents every exported schema, field, enum member and union branch', () => {
      expect(formatIssues(findDocumentationIssues(entries))).toEqual([]);
    });

    it('generates the JSON Schema for what the schemas accept', () => {
      expect(buildJsonSchemaDocument(entries, 'input')).toMatchSnapshot();
    });

    it('generates the JSON Schema for what the schemas produce', () => {
      expect(buildJsonSchemaDocument(entries, 'output')).toMatchSnapshot();
    });
  });
}
