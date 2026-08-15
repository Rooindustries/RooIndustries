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

  test("maps casters to scheduled matches while owners retain full control", () => {
    const access = loadAccess();
    const yukariMatch = { schedule: { casterIds: [1] } };
    const supaMatch = { schedule: { casterIds: [2] } };
    const sharedPurpleMatch = {
      schedule: { casterIds: [1] },
      casters: [{ id: 1, label: "Yukari + SpankyCheeze" }],
    };
    const finalMatch = {
      schedule: { casterIds: [1, 2] },
      casters: [
        { id: 1, label: "Yukari" },
        { id: 2, label: "Supa" },
      ],
    };
    const lemonAceMatch = {
      schedule: { casterIds: [6, 7] },
      casters: [
        { id: 6, label: "Lemon" },
        { id: 7, label: "Ace" },
      ],
    };

    expect(access.canAccessTourneyManage({ role: "owner" })).toBe(true);
    expect(access.canAccessTourneyManage({ role: "caster" })).toBe(false);
    expect(access.getTourneyCasterIds({ username: "SpankyCheeze", role: "caster" })).toEqual([1]);
    expect(access.getTourneyCasterIds({ username: "Ace", role: "caster" })).toEqual([7]);
    expect(access.getTourneyCasterIds({ username: "unknown", role: "caster" })).toEqual([]);
    expect(access.canManageTourneyMatch({
      session: { username: "yukari", role: "caster" },
      match: yukariMatch,
    })).toBe(true);
    expect(access.canManageTourneyMatch({
      session: { username: "supa", role: "caster" },
      match: yukariMatch,
    })).toBe(false);
    expect(access.canManageTourneyMatch({
      session: { username: "spankycheeze", role: "caster" },
      match: sharedPurpleMatch,
    })).toBe(true);
    expect(access.canManageTourneyMatch({
      session: { username: "spankycheeze", role: "caster" },
      match: finalMatch,
    })).toBe(false);
    expect(access.canManageTourneyMatch({
      session: { username: "supa", role: "caster" },
      match: finalMatch,
    })).toBe(true);
    expect(access.canManageTourneyMatch({
      session: { username: "ace", role: "caster" },
      match: lemonAceMatch,
    })).toBe(true);
    expect(access.canManageTourneyMatch({
      session: { username: "lemon", role: "caster" },
      match: lemonAceMatch,
    })).toBe(true);
    expect(access.canManageTourneyMatch({
      session: { username: "ace", role: "caster" },
      match: finalMatch,
    })).toBe(false);
    expect(access.canManageTourneyMatch({
      session: { username: "serviroo", role: "owner" },
      match: supaMatch,
    })).toBe(true);
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
