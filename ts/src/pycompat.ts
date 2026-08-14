/**
 * Python semantics that JavaScript does not share.
 *
 * Each helper here exists because a faithful port hit a place where the two
 * languages quietly disagree. They were originally written three times, once
 * per module, because the port ran as parallel isolated agents. Two copies of
 * a subtle rule is a defect waiting to happen — fix one, miss the other, and
 * the behaviours drift apart silently. They live here now, in one place.
 */

/**
 * Python truthiness for an arbitrary JSON-decoded value.
 *
 * `None`, `False`, `0`/`0.0`, `""`, `[]` and `{}` are falsy. JavaScript agrees
 * on the scalars and disagrees on the containers: `[]` and `{}` are always
 * truthy in JS. That gap matters wherever the Python uses `or` as a fallback
 * over untrusted JSON — `{"type": "error", "error": {}}` must fall through to
 * the whole event in Python, but a plain `||` keeps the empty object.
 *
 * NaN is deliberately truthy, matching `bool(float('nan'))`.
 */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * Slice by Unicode code point, as Python's `s[:n]` does.
 *
 * JavaScript's `.slice()` counts UTF-16 code units, so it can cut an astral
 * character in half and leave a lone surrogate. Used for the 500-character
 * truncation of error bodies, which are attacker-influenced text.
 */
export function codepointSlice(s: string, end: number): string {
  return Array.from(s).slice(0, end).join("");
}

/** True for a JSON-decoded plain object — not null, not an array. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
