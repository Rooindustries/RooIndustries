const loadAccess = () => {
  jest.resetModules();
  return require("../server/tourney/access.js");
};

describe("tourney access helpers", () => {
  test("allows registration for guests, casters, and owners only", () => {
    const access = loadAccess();

    expect(access.canAccessTourneyRegistration(null)).toBe(true);
    expect(access.canAccessTourneyRegistration({ role: "caster" })).toBe(true);
    expect(access.canAccessTourneyRegistration({ role: "owner" })).toBe(true);
    expect(access.canAccessTourneyRegistration({ role: "player" })).toBe(false);
    expect(access.canAccessTourneyRegistration({ role: "viewer" })).toBe(false);
  });

  test("requires decision links to match the active approver session", () => {
    const access = loadAccess();
    const approver = {
      username: "yukari",
      role: "caster",
    };

    expect(
      access.isMatchingTourneyApproverSession({
        session: { username: "Yukari", role: "caster" },
        approver,
      })
    ).toBe(true);
    expect(
      access.isMatchingTourneyApproverSession({
        session: null,
        approver,
      })
    ).toBe(false);
    expect(
      access.isMatchingTourneyApproverSession({
        session: { username: "yukari", role: "player" },
        approver,
      })
    ).toBe(false);
    expect(
      access.isMatchingTourneyApproverSession({
        session: { username: "serviroo", role: "owner" },
        approver,
      })
    ).toBe(false);
    expect(
      access.isMatchingTourneyApproverSession({
        session: { username: "yukari", role: "caster" },
        approver: { username: "yukari", role: "viewer" },
      })
    ).toBe(false);
  });
});
