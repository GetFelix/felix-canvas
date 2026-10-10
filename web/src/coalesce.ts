import { mergeTextUpdates } from "@felix-canvas/model";

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

/**
 * A token bucket: `perSecond` writes a second, up to `burst` at once. The
 * gateway refuses a write over its per-session rate instead of queueing it,
 * so a session paces its own writes below that rate.
 */
export class WriteBudget {
  readonly #perMs: number;
  readonly #burst: number;
  #tokens: number;
  #at: number;

  constructor(perSecond: number, burst: number, now = performance.now()) {
    this.#perMs = perSecond / 1000;
    this.#burst = burst;
    this.#tokens = burst;
    this.#at = now;
  }

  /** Spend one write if the budget has one. */
  take(now = performance.now()): boolean {
    this.#refill(now);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  /** Milliseconds until {@link take} would succeed. */
  wait(now = performance.now()): number {
    this.#refill(now);
    return this.#tokens >= 1 ? 0 : Math.ceil((1 - this.#tokens) / this.#perMs);
  }

  #refill(now: number): void {
    this.#tokens = Math.min(this.#burst, this.#tokens + (now - this.#at) * this.#perMs);
    this.#at = now;
  }
}

/**
 * Collects the editor's Yjs updates and hands them on as one, merged:
 * `delayMs` after the first unsent one, so steady typing sends a few ops a
 * second, at once past `maxBytes`, which in practice is a paste, and
 * whenever it is flushed.
 */
export class TypingBuffer {
  readonly #send: (update: Uint8Array, firstAt: number) => void;
  readonly #delayMs: number;
  readonly #maxBytes: number;
  #updates: Uint8Array[] = [];
  #bytes = 0;
  #firstAt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    send: (update: Uint8Array, firstAt: number) => void,
    delayMs = 150,
    maxBytes = 8 * 1024,
  ) {
    this.#send = send;
    this.#delayMs = delayMs;
    this.#maxBytes = maxBytes;
  }

  add(update: Uint8Array): void {
    if (this.#updates.length === 0) {
      this.#firstAt = Date.now();
      this.#timer = setTimeout(() => this.flush(), this.#delayMs);
    }
    this.#updates.push(update);
    this.#bytes += update.length;
    if (this.#bytes > this.#maxBytes) this.flush();
  }

  /** Send what is collected now. */
  flush(): void {
    clearTimeout(this.#timer);
    if (this.#updates.length === 0) return;
    const merged = mergeTextUpdates(this.#updates);
    this.#updates = [];
    this.#bytes = 0;
    this.#send(merged, this.#firstAt);
  }
}
