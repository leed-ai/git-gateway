// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/**
 * Whether the installed Zod lets two schemas register the same id. Zod 4.0 throws; later 4.x
 * releases accept it, which is why the harness checks id uniqueness itself.
 */
export const duplicateIdsAllowed: boolean = (() => {
  try {
    z.string().meta({ id: 'probe.duplicate' });
    z.number().meta({ id: 'probe.duplicate' });
    return true;
  } catch {
    return false;
  }
})();
