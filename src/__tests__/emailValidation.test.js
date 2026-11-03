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
  const shortValue = "a@" + "b.".repeat(310) + "bc";
  expect(shortValue).toHaveLength(624);
  const cost = (input, calls) => {
    let accepted = 0;
    const started = performance.now();
    for (let call = 0; call < calls; call++) accepted += isValidEmail(input);
    const elapsed = performance.now() - started;
    expect(accepted).toBe(0);
    return elapsed;
  };
  const rounds = Array.from({ length: 7 }, () => [cost(value, 100), cost(shortValue, 1600)]);
  expect(Math.min(...rounds.map(([long]) => long))).toBeLessThan(4 * Math.min(...rounds.map(([, short]) => short)));
});
