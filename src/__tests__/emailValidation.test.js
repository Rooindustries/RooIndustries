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
  const compare = (longLength) => {
    const longInput = address(longLength);
    const shortInput = address(shortLength);
    expect([longInput.length, shortInput.length]).toEqual([longLength, shortLength]);
    const rounds = Array.from({ length: 7 }, () => [
      cost(longInput, 4),
      cost(shortInput, (4 * longLength) / shortLength),
    ]);
    const long = Math.min(...rounds.map(([elapsed]) => elapsed));
    const short = Math.min(...rounds.map(([, elapsed]) => elapsed));
    return long / short;
  };
  const ratios = [];
  for (const longLength of [16384, 65536]) {
    ratios.push(compare(longLength));
    if (ratios.at(-1) >= 8) {
      break;
    }
  }
  expect(Math.max(...ratios)).toBeLessThan(4);
});
