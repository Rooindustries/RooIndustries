import { isValidEmail } from "../lib/emailValidation";

test.each(["a@.b.c", "a@b..c", "a@b.", "a@-b.c", "a@b-.c", "a@b!c.de", "a@@b.c", "a b@c.de", "a@b\u007fc.de", undefined, null, 42])("rejects malformed email %p", (value) => {
  expect(isValidEmail(value)).toBe(false);
});

test.each(["user@exämple.de", "first.last+tag@sub.domain.com", " visitor@example.invalid ", "owner@example.invalid", "booking@roo.test"])("accepts valid email %p", (value) => {
  expect(isValidEmail(value)).toBe(true);
});

const domain = ["c".repeat(63), "c".repeat(63), "c".repeat(63), "c".repeat(60)].join(".");
const longestAddress = "a@" + domain;
const tooLongAddress = "aa@" + domain;

const patternWork = () => {
  const spies = [
    jest.spyOn(RegExp.prototype, "test"),
    jest.spyOn(RegExp.prototype, "exec"),
    jest.spyOn(String.prototype, "split"),
    jest.spyOn(String.prototype, "indexOf"),
    jest.spyOn(String.prototype, "lastIndexOf"),
  ];
  spies.forEach((spy) => spy.mockClear());
  return {
    stop: () => {
      const calls = spies.map((spy) => spy.mock.calls.length);
      spies.forEach((spy) => spy.mockRestore());
      return calls;
    },
  };
};

test("accepts exactly 254 characters and rejects 255", () => {
  expect([longestAddress.length, tooLongAddress.length]).toEqual([254, 255]);
  expect(isValidEmail(longestAddress)).toBe(true);
  expect(isValidEmail(tooLongAddress)).toBe(false);
});

test("rejects an over-long address before any pattern or label work", () => {
  const value = "a@" + "b.".repeat(4998) + "bc";
  expect(value).toHaveLength(10000);
  for (const input of [tooLongAddress, value]) {
    const work = patternWork();
    const valid = isValidEmail(input);
    const calls = work.stop();
    expect(valid).toBe(false);
    expect(calls).toEqual([0, 0, 0, 0, 0]);
  }
  const work = patternWork();
  const valid = isValidEmail(longestAddress);
  const [regexTests, , splits, indexes, lastIndexes] = work.stop();
  expect(valid).toBe(true);
  expect([regexTests > 0, splits, indexes, lastIndexes]).toEqual([true, 1, 1, 1]);
});
