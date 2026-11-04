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
  expect(isValidEmail(value)).toBe(false);
  const address = (length) => "a@" + "b.".repeat(length / 2 - 2) + "bc";
  const cost = (input, calls) => {
    let accepted = 0;
    const started = performance.now();
    for (let call = 0; call < calls; call++) {
      accepted += isValidEmail(input);
    }
    const elapsed = performance.now() - started;
    expect(accepted).toBe(0);
    return elapsed;
  };
  const shortLength = 1024;
  const rounds = 7;
  const ratioLimit = 4;
  const compare = (longLength) => {
    const longInput = address(longLength);
    const shortInput = address(shortLength);
    expect([longInput.length, shortInput.length]).toEqual([longLength, shortLength]);
    const elapsed = { long: [], short: [] };
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 ? ["short", "long"] : ["long", "short"];
      for (const side of order) {
        const input = side === "long" ? longInput : shortInput;
        elapsed[side].push(cost(input, (4 * longLength) / input.length));
      }
    }
    const longMs = Math.min(...elapsed.long);
    const shortMs = Math.min(...elapsed.short);
    return { longLength, longMs, shortMs, ratio: Number((longMs / shortMs).toFixed(2)) };
  };
  const steps = [];
  for (const longLength of [16384, 65536]) {
    const step = compare(longLength);
    steps.push(step);
    if (step.longMs >= 8 * step.shortMs) {
      break;
    }
  }
  expect(steps.filter((step) => step.longMs >= ratioLimit * step.shortMs)).toEqual([]);
});
