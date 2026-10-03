/**
 * Paces presence messages: at most one per `gapMs` while something changes,
 * however often it changes, and one every `heartbeatMs` while nothing does.
 */
export class Coalescer {
  readonly #gapMs: number;
  readonly #heartbeatMs: number;
  #dirty = true;
  #sentAt = -Infinity;

  constructor(gapMs: number, heartbeatMs: number) {
    this.#gapMs = gapMs;
    this.#heartbeatMs = heartbeatMs;
  }

  /** Something worth sending changed. */
  mark(): void {
    this.#dirty = true;
  }

  /** Whether to send now. Call once a frame; `true` counts as sent. */
  take(now: number): boolean {
    const since = now - this.#sentAt;
    if ((this.#dirty && since >= this.#gapMs) || since >= this.#heartbeatMs) {
      this.#dirty = false;
      this.#sentAt = now;
      return true;
    }
    return false;
  }
}
