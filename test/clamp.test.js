import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { clamp } from "../index.js";

test("clamp returns a value inside the range unchanged", () => {
  strictEqual(clamp(5, 0, 10), 5);
});

test("clamp raises a value below min to min", () => {
  strictEqual(clamp(-3, 0, 10), 0);
});

test("clamp lowers a value above max to max", () => {
  strictEqual(clamp(42, 0, 10), 10);
});

test("clamp handles negative bounds", () => {
  strictEqual(clamp(-10, -5, -1), -5);
  strictEqual(clamp(-3, -5, -1), -3);
  strictEqual(clamp(0, -5, -1), -1);
});

test("clamp handles equal bounds", () => {
  strictEqual(clamp(7, 3, 3), 3);
  strictEqual(clamp(3, 3, 3), 3);
});

test("clamp throws RangeError when min > max", () => {
  throws(() => clamp(5, 10, 0), RangeError);
  throws(() => clamp(5, 10, 0), /min \(10\).*max \(0\)/);
});
