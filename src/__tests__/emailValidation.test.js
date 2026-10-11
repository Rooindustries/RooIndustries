import { performance } from "node:perf_hooks";
import { isValidEmail } from "../lib/emailValidation";

test.each(["a@.b.c", "a@b..c", "a@b.", "a@-b.c", "a@b-.c", "a@b!c.de", "a@@b.c", "a b@c.de", "a@b\u007fc.de", undefined, null, 42])("rejects malformed email %p", (value) => {
  expect(isValidEmail(value)).toBe(false);
});

test.each(["user@exämple.de", "first.last+tag@sub.domain.com", " visitor@example.invalid ", "owner@example.invalid", "booking@roo.test"])("accepts valid email %p", (value) => {
  expect(isValidEmail(value)).toBe(true);
});

test("rejects a 10,000-character input without expensive matching", () => {
  const value = "a@" + "b.".repeat(4998) + "bc";
  expect(value).toHaveLength(10000);
  const started = performance.now();
  const valid = isValidEmail(value);
  expect(performance.now() - started).toBeLessThan(100);
  expect(valid).toBe(false);
});
