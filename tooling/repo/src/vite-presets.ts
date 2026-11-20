// SPDX-License-Identifier: Apache-2.0
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import type { UserConfig } from 'vite-plus';

import { PEER_NAMES } from './peer-policy.ts';

type PackConfig = NonNullable<UserConfig['pack']>;
type TestConfig = NonNullable<UserConfig['test']>;
type Plugin = ReturnType<typeof cloudflareTest>;

/** The Workers compatibility date every Worker test and the example Worker run with. */
export const COMPATIBILITY_DATE = '2026-11-01';

/** Imports a library build must leave to the host: the policy peers and the Workers runtime modules. */
export const EXTERNAL_IMPORTS: readonly RegExp[] = [
  ...PEER_NAMES.map((name) => new RegExp(`^${name}(?:/|$)`)),
  /^cloudflare:/,
  /^node:/,
];

/**
 * tsdown settings for a published library: one ESM entry per source module (no barrel),
 * declaration files, and every peer kept external so the host supplies one copy.
 */
export function libraryPack(): PackConfig {
  return {
    entry: ['src/**/*.ts', '!src/**/*.test.ts'],
    format: 'esm',
    platform: 'neutral',
    dts: true,
    sourcemap: true,
    clean: true,
    deps: { neverBundle: [...EXTERNAL_IMPORTS] },
  };
}

/** Vitest settings for a package whose tests run in Node. */
export function nodeTest(overrides: TestConfig = {}): TestConfig {
  return { include: ['test/**/*.test.ts'], ...overrides };
}

/**
 * The Workers Vitest plugin: tests run inside workerd through Miniflare. Pass a Wrangler
 * config path for a deployable Worker; without one the tests get a bare Worker runtime.
 */
export function workersTestPlugin(wranglerConfigPath?: string): Plugin {
  return cloudflareTest(
    wranglerConfigPath === undefined
      ? { miniflare: { compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ['nodejs_compat'] } }
      : { wrangler: { configPath: wranglerConfigPath } },
  );
}
