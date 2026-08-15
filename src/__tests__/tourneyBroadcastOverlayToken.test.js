const loadToken = () => {
  jest.resetModules();
  return require("../server/tourney/broadcastOverlayToken.js");
};

const env = {
  TOURNEY_SESSION_SECRET: "test-tourney-session-secret",
};

describe("tourney broadcast overlay tokens", () => {
  test("creates a durable token bound to one match", () => {
    const tokenApi = loadToken();
    const token = tokenApi.createTourneyBroadcastOverlayToken({ matchId: 22, env });

    expect(tokenApi.verifyTourneyBroadcastOverlayToken({ token, env })).toEqual({
      ok: true,
      matchId: 22,
    });
  });

  test("rejects tampered tokens and different secrets", () => {
    const tokenApi = loadToken();
    const token = tokenApi.createTourneyBroadcastOverlayToken({ matchId: 17, env });
    const [payload, signature] = token.split(".");

    expect(
      tokenApi.verifyTourneyBroadcastOverlayToken({
        token: `${payload}.${signature.slice(0, -1)}x`,
        env,
      })
    ).toEqual({ ok: false });
    expect(
      tokenApi.verifyTourneyBroadcastOverlayToken({
        token,
        env: { TOURNEY_SESSION_SECRET: "another-secret" },
      })
    ).toEqual({ ok: false });
  });
});
