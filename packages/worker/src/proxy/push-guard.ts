// SPDX-License-Identifier: Apache-2.0
import { concatBytes } from '@leed-ai/git-gateway-core/bytes';
import { PackScanner, type PackScan } from '@leed-ai/git-gateway-core/pack/pack-scanner';

import type { RefRefusal } from './git-responses.ts';

/** A pack ends with a 20-byte SHA-1 checksum; holding it back keeps the host from completing the push. */
const HELD_BYTES = 20;

/** The error a guarded stream fails with when the push is refused; the host never sees a complete pack. */
export class PushRefused extends Error {
  override readonly name = 'PushRefused';
  readonly refusals: readonly RefRefusal[];

  constructor(refusals: readonly RefRefusal[]) {
    super(`push refused: ${refusals.map((refusal) => refusal.ref).join(', ')}`);
    this.refusals = refusals;
  }
}

/** Options of {@link guardPush}. */
export interface PushGuardOptions {
  /** Bytes before the pack (the update commands), forwarded without scanning. */
  readonly headLength: number;
  /** Most bytes of commits the scan keeps. */
  readonly maxCommitBytes: number;
  /**
   * Keep the whole pack (checksum included), at most this many bytes, and hand it to `decide`; a
   * longer pack is refused with `tooLarge`. Absent: nothing is kept.
   */
  readonly keepPack?: { readonly maxBytes: number; readonly tooLarge: string };
  /**
   * Decides the push once the whole pack has been scanned, given the pack when `keepPack` asked
   * for it (null otherwise); returns the refused updates (none to allow it).
   */
  readonly decide: (scan: PackScan, pack: Uint8Array | null) => Promise<readonly RefRefusal[]>;
  /** Called with every refused update, scan failures included, before the stream fails. */
  readonly onRefused: (refusals: readonly RefRefusal[]) => void;
  /** The refs to refuse when the pack cannot be scanned, with the reason to give for each. */
  readonly refuseAll: (reason: string) => readonly RefRefusal[];
}

/**
 * A pass-through for a push body that scans the pack as it streams to the storage host, so the
 * gateway can prove fast-forwards from commits the host does not have yet — without buffering the
 * pack. Everything is forwarded as it arrives except the last 20 bytes, the pack checksum; once
 * the body has ended and the scan is complete, `decide` runs, and only if it refuses nothing are
 * those bytes released. With `keepPack`, the pack is also kept (bounded) for `decide` to read
 * whole, as the push policy needs to compute changed paths. On a refusal (or a pack that cannot be read) the stream fails instead, so
 * the host sees a truncated pack and updates no ref.
 */
export function guardPush(options: PushGuardOptions): TransformStream<Uint8Array, Uint8Array> {
  const scanner = new PackScanner({ maxCommitBytes: options.maxCommitBytes });
  let position = 0;
  let held = new Uint8Array(0);
  const kept: Uint8Array[] = [];
  let keptBytes = 0;

  const refuse = (refusals: readonly RefRefusal[]): PushRefused => {
    options.onRefused(refusals);
    return new PushRefused(refusals);
  };
  const unreadable = (error: unknown): PushRefused => {
    const detail = error instanceof Error ? error.message : String(error);
    return refuse(options.refuseAll(`the pushed pack could not be checked: ${detail}`));
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      const start = position;
      position += chunk.length;
      if (position > options.headLength) {
        const packBytes = chunk.subarray(Math.max(0, options.headLength - start));
        if (options.keepPack !== undefined) {
          keptBytes += packBytes.length;
          if (keptBytes > options.keepPack.maxBytes)
            throw refuse(options.refuseAll(options.keepPack.tooLarge));
          kept.push(packBytes.slice());
        }
        try {
          await scanner.push(packBytes);
        } catch (error) {
          throw unreadable(error);
        }
      }
      if (chunk.length >= HELD_BYTES) {
        if (held.length > 0) controller.enqueue(held);
        controller.enqueue(chunk.subarray(0, chunk.length - HELD_BYTES));
        held = chunk.slice(chunk.length - HELD_BYTES);
        return;
      }
      const joined = concatBytes([held, chunk]);
      const release = Math.max(0, joined.length - HELD_BYTES);
      if (release > 0) controller.enqueue(joined.slice(0, release));
      held = joined.slice(release);
    },
    async flush(controller) {
      let scan: PackScan;
      try {
        scan = scanner.finish();
      } catch (error) {
        throw unreadable(error);
      }
      const refusals = await options.decide(scan, options.keepPack === undefined ? null : concatBytes(kept));
      if (refusals.length > 0) throw refuse(refusals);
      if (held.length > 0) controller.enqueue(held);
    },
  });
}
