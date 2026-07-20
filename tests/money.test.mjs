// tests/money.test.mjs - arithmetic tests. No dependencies, no database.
//
//   node tests/money.test.mjs
//
// money.js is pure JavaScript with no Workers APIs, so it can be imported and
// exercised directly. This is the cheapest test in the project and it covers
// the layer everything else sits on: if cents arithmetic is wrong, every
// balance in the bank is wrong.

import {
  toCents,
  fromCents,
  formatCents,
  sumCents,
  interestCents,
  splitCents,
  parseUserAmount,
} from "../src/money.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL  ${name}\n      expected ${e}\n      got      ${a}`);
  }
}

function throws(name, fn) {
  try {
    fn();
    failed++;
    console.log(`FAIL  ${name}\n      expected it to throw, but it returned normally`);
  } catch {
    passed++;
  }
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------
check("whole number", toCents("2500"), 250000);
check("two decimals", toCents("2500.00"), 250000);
check("one decimal is tenths", toCents("0.5"), 50);
check("two decimals small", toCents("0.05"), 5);
check("negative", toCents("-12.34"), -1234);
check("integer number input", toCents(2500), 250000);
check("whitespace tolerated", toCents("  10.00 "), 1000);

// Anything ambiguous must be rejected rather than guessed at.
check("three decimals rejected", toCents("1.005"), null);
check("float input rejected", toCents(1.5), null);
check("scientific notation rejected", toCents("1e3"), null);
check("empty rejected", toCents(""), null);
check("letters rejected", toCents("abc"), null);
check("null rejected", toCents(null), null);
check("comma rejected", toCents("1,000"), null);
check("NaN rejected", toCents(NaN), null);
check("Infinity rejected", toCents(Infinity), null);

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------
check("format whole", fromCents(250000), "2500.00");
check("format cents", fromCents(5), "0.05");
check("format zero", fromCents(0), "0.00");
check("format negative", fromCents(-1234), "-12.34");
check("grouped", formatCents(123456789), "1,234,567.89");
check("grouped negative", formatCents(-123456789), "-1,234,567.89");

// Round trip: any value that parses must format back to the same string.
for (const v of ["0.00", "0.01", "9.99", "1000.00", "123456.78", "-45.60"]) {
  check(`round trip ${v}`, fromCents(toCents(v)), v);
}

// ---------------------------------------------------------------------------
// the float trap this module exists to avoid
// ---------------------------------------------------------------------------
// 0.1 + 0.2 !== 0.3 in floating point. In cents it is exact.
check("no float drift", sumCents([toCents("0.10"), toCents("0.20")]), toCents("0.30"));

// A hundred payments of 0.01 must be exactly 1.00, not 0.9999999999999999.
check(
  "hundred small amounts",
  sumCents(Array(100).fill(toCents("0.01"))),
  toCents("1.00")
);

// ---------------------------------------------------------------------------
// interest
// ---------------------------------------------------------------------------
check("2% of 1000.00", interestCents(100000, 200), 2000);
check("3% of 1000.00", interestCents(100000, 300), 3000);
check("zero balance earns nothing", interestCents(0, 200), 0);
check("negative balance earns nothing", interestCents(-5000, 200), 0);
check("zero rate pays nothing", interestCents(100000, 0), 0);
// Rounds half up on the absolute value, consistently.
check("rounds up at half", interestCents(25, 200), 1); // 0.5 cents -> 1
check("rounds down below half", interestCents(24, 200), 0); // 0.48 -> 0
throws("negative rate rejected", () => interestCents(100000, -1));

// ---------------------------------------------------------------------------
// splitting - nothing may be lost or invented
// ---------------------------------------------------------------------------
check("even split", splitCents(300, 3), [100, 100, 100]);
check("remainder distributed", splitCents(100, 3), [34, 33, 33]);
check("split sums back", sumCents(splitCents(1000, 7)), 1000);
check("split sums back, awkward", sumCents(splitCents(9999, 13)), 9999);
throws("split by zero rejected", () => splitCents(100, 0));

// ---------------------------------------------------------------------------
// user input
// ---------------------------------------------------------------------------
check("user commas stripped", parseUserAmount("1,234.56").cents, 123456);
check("user currency sign stripped", parseUserAmount("$50").cents, 5000);
check("user zero rejected", !!parseUserAmount("0").error, true);
check("user negative rejected", !!parseUserAmount("-5").error, true);
check("user gibberish rejected", !!parseUserAmount("abc").error, true);
check("user below minimum rejected", !!parseUserAmount("0.50", { min: 100 }).error, true);
check("user above maximum rejected", !!parseUserAmount("100.00", { max: 5000 }).error, true);

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
