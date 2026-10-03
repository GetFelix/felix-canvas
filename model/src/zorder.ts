// Fractional indexing: a z key is a base-62 fraction written without its
// leading "0.", so string order is numeric order and there is always room for
// another key between two neighbours. ASCII orders 0-9 < A-Z < a-z.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

/** Whether `key` is a z key {@link keyBetween} could have produced. */
export function isZKey(key: unknown): key is string {
  return typeof key === "string" && KEY.test(key);
}

/**
 * A z key strictly between `below` and `above`. `null` means no neighbour on
 * that side, so `keyBetween(top, null)` puts a shape above everything.
 *
 * @throws RangeError if a key is malformed or `below` is not below `above`.
 */
export function keyBetween(below: string | null, above: string | null): string {
  for (const key of [below, above]) {
    if (key !== null && !isZKey(key)) throw new RangeError(`bad z key ${key}`);
  }
  if (below !== null && above !== null && below >= above) {
    throw new RangeError(`${below} is not below ${above}`);
  }
  // New shapes go on top, so the open-ended cases step one digit rather than
  // halving the gap, which would add a character every few shapes.
  if (above === null) return below === null ? "V" : step(below, 1)!;
  if (below === null) return step(above, -1) ?? midpoint("", above);
  return midpoint(below, above);
}

function step(key: string, by: 1 | -1): string | undefined {
  for (let i = 0; i < key.length; i++) {
    const digit = DIGITS.indexOf(key[i]!) + by;
    if (digit >= 1 && digit < DIGITS.length) return key.slice(0, i) + DIGITS[digit];
  }
  return by > 0 ? key + "V" : undefined;
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const low = a === "" ? 0 : DIGITS.indexOf(a[0]!);
  const high = b === null ? DIGITS.length : DIGITS.indexOf(b[0]!);
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)]!;
  // Adjacent digits: b's first digit alone is already between, unless b is
  // exactly that digit, in which case extend a.
  if (b !== null && b.length > 1) return b[0]!;
  return DIGITS[low]! + midpoint(a.slice(1), null);
}
