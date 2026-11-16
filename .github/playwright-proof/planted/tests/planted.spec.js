const { expect, test } = require("@playwright/test");

test("adds", () => {
  expect(1 + 1).toBe(2);
});

test.describe("in a group", () => {
  test("adds", () => {
    expect(2 + 2).toBe(4);
  });
});
