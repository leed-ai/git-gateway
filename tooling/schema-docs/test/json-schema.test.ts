// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { buildJsonSchemaDocument } from '../src/json-schema.ts';
import { duplicateIdsAllowed } from './duplicate-ids.ts';

const meta = (id: string) => ({ id, title: id, description: `${id} schema.`, examples: [] });

describe('buildJsonSchemaDocument', () => {
  it('puts every named schema, nested ones included, under sorted $defs', () => {
    const Inner = z.object({ n: z.number().describe('A number.') }).meta(meta('json.Inner'));
    const Outer = z.object({ inner: Inner }).meta(meta('json.Outer'));
    const document = buildJsonSchemaDocument([{ name: 'm#Outer', schema: Outer }]);
    expect(Object.keys(document.$defs)).toEqual(['json.Inner', 'json.Outer']);
    expect(document).toMatchSnapshot();
  });

  it('skips unnamed entries', () => {
    expect(buildJsonSchemaDocument([{ name: 'm#S', schema: z.string() }]).$defs).toEqual({});
  });

  it('describes the input or the output side of a transform', () => {
    const Length = z
      .string()
      .describe('Text whose length is taken.')
      .pipe(z.transform((value: string) => value.length))
      .pipe(z.number().describe('The length.'))
      .meta(meta('json.Length'));
    const entries = [{ name: 'm#Length', schema: Length }];
    expect(buildJsonSchemaDocument(entries, 'input').$defs['json.Length']).toMatchObject({ type: 'string' });
    expect(buildJsonSchemaDocument(entries, 'output').$defs['json.Length']).toMatchObject({ type: 'number' });
  });

  it('emits nodes JSON Schema cannot express as open schemas that keep their descriptions', () => {
    const Unrepresentable = z
      .object({
        length: z
          .string()
          .transform((value) => value.length)
          .describe('Text, reported as its length.'),
        bytes: z.instanceof(Uint8Array).describe('Raw bytes.'),
        when: z.date().describe('A moment.'),
        size: z.bigint().describe('A large count.'),
        token: z.custom<string>((value) => typeof value === 'string').describe('An opaque token.'),
      })
      .meta(meta('json.Unrepresentable'));
    const entries = [{ name: 'm#Unrepresentable', schema: Unrepresentable }];
    for (const side of ['input', 'output'] as const) {
      const properties = Reflect.get(
        Object(buildJsonSchemaDocument(entries, side).$defs['json.Unrepresentable']),
        'properties',
      );
      expect(properties).toMatchObject({
        length: { description: 'Text, reported as its length.' },
        bytes: { description: 'Raw bytes.' },
        when: { description: 'A moment.' },
        size: { description: 'A large count.' },
        token: { description: 'An opaque token.' },
      });
    }
  });

  it.skipIf(!duplicateIdsAllowed)('fails when one id generates two different schemas', () => {
    const first = z.string().meta(meta('json.Clash'));
    const second = z.number().meta(meta('json.Clash'));
    expect(() =>
      buildJsonSchemaDocument([
        { name: 'm#First', schema: first },
        { name: 'm#Second', schema: second },
      ]),
    ).toThrow(/json\.Clash/);
  });
});
