// money.js — all monetary arithmetic for Z&E Bank.
// ===========================================================================
// ONE RULE: money is an integer number of cents, and it never becomes a float.
//
// The Treasury API returns amounts as decimal STRINGS and its own docs say
// why: "Never JSON number — IEEE 754 rounding will silently corrupt amounts at
// scale." A bank paying 2-5% monthly compound interest across thousands of
// accounts is exactly that scale. 0.1 + 0.2 !== 0.3, and at a bank that
// difference is somebody's money.
//
// So: parse decimal strings to integer cents at the edge, do every calculation
// in integers, and format back to a decimal string only when sending to the
// Treasury or rendering to a human.
// ===========================================================================

// JavaScript integers are exact to 2^53. In cents that is ~90 trillion in
// currency — far beyond any DemocracyCraft balance — but we assert rather than
// assume, because silently losing precision is the whole failure mode we're
// avoiding.
export const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

const DECIMAL_RE = /^-?\d{1,15}(\.\d{1,2})?$/;

/**
 * Parse a decimal money string into integer cents.
 * Accepts "1234", "1234.5", "1234.56", "-12.34". Rejects anything else —
 * including scientific notation, more than 2 decimal places, empty strings,
 * NaN, Infinity, and JS numbers that aren't integers.
 *
 * Returns null on invalid input. Callers MUST check for null; never default a
 * failed parse to 0, because "0" and "unparseable" are very different things
 * when moving money.
 */
export function toCents(value) {
  if (value === null || value === undefined) return null;

  // A JS number is only acceptable if it's an exact integer (a whole currency
  // amount). A fractional float has already lost precision before reaching us.
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return null;
    const cents = value * 100;
    return Number.isSafeInteger(cents) ? cents : null;
  }

  const s = String(value).trim();
  if (!DECIMAL_RE.test(s)) return null;

  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const [whole, frac = ""] = body.split(".");

  // Pad "5" -> "50" so .5 is fifty cents, not five.
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;

  return negative ? -cents : cents;
}

/**
 * Integer cents -> the decimal string the Treasury API expects ("1234.56").
 * Always exactly two decimal places.
 */
export function fromCents(cents) {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Human display with thousands separators: "1,234.56". */
export function formatCents(cents) {
  const raw = fromCents(cents);
  const negative = raw.startsWith("-");
  const [whole, frac] = (negative ? raw.slice(1) : raw).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${frac}`;
}

/** Throws unless `v` is a safe integer number of cents. */
export function assertCents(v) {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    throw new Error(`money: expected integer cents, got ${JSON.stringify(v)}`);
  }
  return v;
}

/** Sum of integer cents, with overflow checking. */
export function sumCents(list) {
  let total = 0;
  for (const v of list) {
    assertCents(v);
    total += v;
    if (!Number.isSafeInteger(total)) throw new Error("money: sum overflowed");
  }
  return total;
}

/**
 * Interest for one period, in integer cents.
 *
 * rateBps is monthly basis points: 200 = 2.00%, 300 = 3.00%.
 *
 * Rounding is HALF-UP on the absolute value, so the fraction of a cent goes to
 * the customer rather than being truncated away. That choice is deliberate and
 * consistent — an inconsistent rounding rule is how a ledger slowly drifts.
 *
 * Uses Math.round on an integer-scaled product; the intermediate is exact for
 * any realistic balance (balance_cents * 10000 stays well inside 2^53).
 */
export function interestCents(basisCents, rateBps) {
  assertCents(basisCents);
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new Error(`money: bad rate ${rateBps}`);
  }
  if (basisCents <= 0 || rateBps === 0) return 0;

  const scaled = basisCents * rateBps; // exact integer
  if (!Number.isSafeInteger(scaled)) throw new Error("money: interest overflowed");
  return Math.round(scaled / 10000);
}

/**
 * Split `totalCents` into `parts` as evenly as possible with nothing lost.
 * The remainder is distributed one cent at a time to the earliest parts, so
 * the pieces always add back to exactly the total. Used by payroll and any
 * future pro-rata distribution.
 */
export function splitCents(totalCents, parts) {
  assertCents(totalCents);
  if (!Number.isInteger(parts) || parts <= 0) throw new Error("money: bad split");
  const base = Math.trunc(totalCents / parts);
  let remainder = totalCents - base * parts;
  const out = new Array(parts).fill(base);
  const step = remainder >= 0 ? 1 : -1;
  for (let i = 0; remainder !== 0; i = (i + 1) % parts) {
    out[i] += step;
    remainder -= step;
  }
  return out;
}

/**
 * Parse user form input, which is messier than API input — people type
 * "1,234.5", " 20 ", or "$50". Still refuses anything ambiguous.
 * Returns { cents } or { error }.
 */
export function parseUserAmount(input, { min = 1, max = null } = {}) {
  const cleaned = String(input ?? "").trim().replace(/[$,\s]/g, "");
  if (!cleaned) return { error: "Enter an amount." };

  const cents = toCents(cleaned);
  if (cents === null) return { error: "That isn't a valid amount. Use a number like 250.00" };
  if (cents <= 0) return { error: "Amount must be greater than zero." };
  if (cents < min) return { error: `Minimum is ${formatCents(min)}.` };
  if (max !== null && cents > max) return { error: `Maximum is ${formatCents(max)}.` };

  return { cents };
}
