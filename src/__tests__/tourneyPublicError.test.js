import { buildTourneyPublicError } from "../server/tourney/publicError";

jest.mock("../server/safeErrorLog", () => ({ logSafeError: jest.fn() }));

describe("Tourney public error mapping", () => {
  test("preserves the safe paused-writes 503 contract", () => {
    expect(buildTourneyPublicError(Object.assign(
      new Error("Tournament updates are briefly paused. Try again shortly."),
      { code: "TOURNEY_WRITES_PAUSED", status: 503 }
    ), "fallback")).toEqual({
      status: 503,
      message: "Tournament updates are briefly paused. Try again shortly.",
      code: "TOURNEY_WRITES_PAUSED",
    });
  });

  test("keeps unrelated server errors generic", () => {
    expect(buildTourneyPublicError(Object.assign(
      new Error("private database detail"),
      { code: "PRIVATE_FAILURE", status: 503 }
    ), "fallback")).toEqual({ status: 500, message: "fallback" });
  });
});
