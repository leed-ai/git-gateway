// SPDX-License-Identifier: Apache-2.0

/** Thrown when a push cannot be checked within the configured bounds; the push is refused. */
export class Uncheckable extends Error {
  override readonly name = 'Uncheckable';
}

/** Counts storage calls against a limit (SmartHttpConfig.maxPushPolicyReads). */
export class ReadBudget {
  readonly #limit: number;
  #used = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** How many calls have been made. */
  get used(): number {
    return this.#used;
  }

  /** Records one storage call; throws {@link Uncheckable} past the limit. */
  spend(): void {
    this.#used += 1;
    if (this.#used > this.#limit) throw new Uncheckable(`it needs more than ${this.#limit} storage reads`);
  }
}
