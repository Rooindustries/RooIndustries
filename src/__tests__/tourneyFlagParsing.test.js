const {
  isEnabledTourneyFlag,
} = require("../server/tourney/canonical");

describe("Tourney flag parsing", () => {
  test.each(["1", "true", "TRUE", " yes ", "  On  "])(
    "accepts canonical truthy value %p",
    (value) => {
      expect(isEnabledTourneyFlag(value)).toBe(true);
    }
  );

  test.each([undefined, null, "", "0", "false", "off", "enabled"])(
    "rejects non-truthy value %p",
    (value) => {
      expect(isEnabledTourneyFlag(value)).toBe(false);
    }
  );
});
