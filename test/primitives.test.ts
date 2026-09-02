import assert from "node:assert/strict";
import test from "node:test";

import {
  compareUnicodeCodePoints,
  hasExactKeys,
  isPlainObject,
  isValidIdentifier,
  isValidTimestamp,
  isWellFormedUnicode,
} from "../src/validation/primitives.ts";

void test("recognizes plain objects and exact keys", () => {
  assert.equal(isPlainObject({ value: 1 }), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(new Date()), false);

  assert.equal(
    hasExactKeys({ first: 1, second: 2 }, ["first", "second"]),
    true,
  );
  assert.equal(hasExactKeys({ first: 1 }, ["first", "second"]), false);
  assert.equal(
    hasExactKeys({ first: 1, second: 2, third: 3 }, ["first", "second"]),
    false,
  );
});

void test("validates identifiers by Unicode code point", () => {
  assert.equal(isValidIdentifier("\u{1f600}", 1), true);
  assert.equal(isValidIdentifier("\u{1f600}a", 1), false);
  assert.equal(isValidIdentifier("   ", 3), false);
  assert.equal(isValidIdentifier("\ud800", 1), false);
  assert.equal(isWellFormedUnicode("\u{10ffff}"), true);
});

void test("validates canonical UTC RFC 3339 millisecond timestamps", () => {
  assert.equal(isValidTimestamp("2024-02-29T23:59:59.999Z"), true);
  assert.equal(isValidTimestamp("2023-02-29T23:59:59.999Z"), false);
  assert.equal(isValidTimestamp("2024-02-29T23:59:59Z"), false);
  assert.equal(isValidTimestamp("2024-02-29T23:59:59.999+00:00"), false);
});

void test("compares strings by Unicode code point", () => {
  const values = ["\u{10000}", "\ue000", "a", "aa"];
  assert.deepEqual(values.sort(compareUnicodeCodePoints), [
    "a",
    "aa",
    "\ue000",
    "\u{10000}",
  ]);
});
