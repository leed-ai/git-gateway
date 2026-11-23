// SPDX-License-Identifier: Apache-2.0
import { concatBytes } from '@leed-ai/git-gateway-core/bytes';
import { PackScanner, type PackScan } from '@leed-ai/git-gateway-core/pack/pack-scanner';

import { drain } from '../policy/enforce-branch-policy.ts';
import type { RefRefusal } from './git-responses.ts';

/** A pack ends with a 20-byte SHA-1 checksum; holding it back keeps the host from completing the push. */
const HELD_BYTES = 20;

/** The reason given for every ref when the pushed pack cannot be read. */
function unreadablePack(error: unknown): string {
  return `the pushed pack could not be checked: ${error instanceof Error ? error.message : String(error)}`;
}

/** Options of {@link holdPush}. */
export interface HoldPushOptions {
  /** Bytes before the pack (the update commands), kept without scanning. */
  readonly headLength: number;
  /** Most bytes of commits the scan keeps. */
  readonly maxCommitBytes: number;
  /** Most bytes of pack held; past it the push overflows (see `overflow`). */
  readonly maxPackBytes: number;
  /**
   * What a pack longer than `maxPackBytes` gets: refused with this reason for every ref, or, when
   * `stream`, handed back as an {@link OverflowingPush} to be streamed.
   */
  readonly overflow: { readonly refuse: string } | 'stream';
}

/** A push read whole: its bytes, the pack within them and what a scan of the pack found. */
export interface HeldPush {
  readonly kind: 'held';
  /** The whole request body, head and pack, exactly as the client sent it. */
  readonly body: Uint8Array;
  /** The pack, checksum included (a view into `body`). */
  readonly pack: Uint8Array;
  readonly scan: PackScan;
}

/** A push that could not be held: too large, unreadable, or cut short; every ref gets `reason`. */
export interface UnheldPush {
  readonly kind: 'unheld';
  readonly reason: string;
}

/**
 * A push longer than the bound, when it may be streamed: the whole body again (what was read,
 * then the rest), and the scanner that has seen the first `scannedBytes` bytes of it.
 */
export interface OverflowingPush {
  readonly kind: 'overflow';
  readonly body: ReadableStream<Uint8Array>;
  readonly scanner: PackScanner;
  readonly scannedBytes: number;
}

/** A byte stream of `first`, then whatever `reader` still has. */
function prepend(first: readonly Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = first[index];
      if (chunk !== undefined) {
        index += 1;
        controller.enqueue(chunk);
        return;
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: async (reason) => reader.cancel(reason),
  });
}

/**
 * Reads a push body to its end into memory — at most `maxPackBytes` of pack — scanning the pack
 * for commits as it arrives, so the gateway can make every storage read its checks need before it
 * opens the receive-pack to the storage host. A storage host may serialise per repository (lock
 * a repository for the whole of each request); a read made while the gateway's own push to it is
 * open would then wait forever. A pack that cannot be scanned, or is too large when `overflow`
 * refuses, is answered with a reason after what remains of the body is drained (bounded), and
 * nothing is sent to storage; a pack too large to hold that may be streamed is handed back.
 */
export async function holdPush(
  body: ReadableStream<Uint8Array>,
  options: HoldPushOptions,
): Promise<HeldPush | UnheldPush | OverflowingPush> {
  const scanner = new PackScanner({ maxCommitBytes: options.maxCommitBytes });
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let position = 0;
  const unheld = async (reason: string): Promise<UnheldPush> => {
    reader.releaseLock();
    await drain(body);
    return { kind: 'unheld', reason };
  };
  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch (error) {
      return unheld(unreadablePack(error));
    }
    if (next.done) break;
    const chunk = next.value;
    const start = position;
    position += chunk.length;
    chunks.push(chunk);
    if (position - options.headLength > options.maxPackBytes) {
      if (options.overflow !== 'stream') return unheld(options.overflow.refuse);
      return { kind: 'overflow', body: prepend(chunks, reader), scanner, scannedBytes: start };
    }
    if (position > options.headLength) {
      try {
        await scanner.push(chunk.subarray(Math.max(0, options.headLength - start)));
      } catch (error) {
        return unheld(unreadablePack(error));
      }
    }
  }
  let scan: PackScan;
  try {
    scan = scanner.finish();
  } catch (error) {
    return { kind: 'unheld', reason: unreadablePack(error) };
  }
  const whole = concatBytes(chunks);
  return { kind: 'held', body: whole, pack: whole.subarray(options.headLength), scan };
}

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
  /**
   * Carry on a scan begun elsewhere: `scanner` has already seen the first `scannedBytes` bytes of
   * the body, which still pass through. Absent: a new scan from the start of the pack.
   */
  readonly resume?: { readonly scanner: PackScanner; readonly scannedBytes: number };
}

/**
 * A pass-through for a push body that scans the pack as it streams to the storage host, so the
 * gateway can prove fast-forwards from commits the host does not have yet without buffering the
 * pack (the receive-pack handler uses it for a pack too large for {@link holdPush}). Everything is
 * forwarded as it arrives except the last 20 bytes, the pack checksum; once the body has ended and
 * the scan is complete, `decide` runs, and only if it refuses nothing are those bytes released.
 * The receive-pack request is open while `decide` runs, so `decide` must not read the repository
 * through the storage backend: a host that locks a repository per request would make that read
 * wait on this push forever. With `keepPack`, the pack is also kept (bounded) for `decide` to read
 * whole. On a refusal (or a pack that cannot be read) the stream fails instead, so the host sees a
 * truncated pack and updates no ref.
 */
export function guardPush(options: PushGuardOptions): TransformStream<Uint8Array, Uint8Array> {
  const scanner = options.resume?.scanner ?? new PackScanner({ maxCommitBytes: options.maxCommitBytes });
  const scanFrom = Math.max(options.headLength, options.resume?.scannedBytes ?? 0);
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
      if (options.keepPack !== undefined && position > options.headLength) {
        const packBytes = chunk.subarray(Math.max(0, options.headLength - start));
        keptBytes += packBytes.length;
        if (keptBytes > options.keepPack.maxBytes) throw refuse(options.refuseAll(options.keepPack.tooLarge));
        kept.push(packBytes.slice());
      }
      if (position > scanFrom) {
        try {
          await scanner.push(chunk.subarray(Math.max(0, scanFrom - start)));
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
