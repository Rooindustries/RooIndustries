const mockFindActiveTourneyApprover = jest.fn();
const mockReadTourneySessionFromStore = jest.fn();
const mockApplyRegistrationDecision = jest.fn();
const mockGetRegistrationDecisionToken = jest.fn();
const mockHashTourneyToken = jest.fn((token) => `hashed:${token}`);
const mockEnqueueTourneyEmailDispatch = jest.fn();
const mockExecuteTourneyCommand = jest.fn();

jest.mock("../server/tourney/auth", () => ({
  TOURNEY_SESSION_COOKIE: "tourney_session",
  findActiveTourneyApprover: (...args) => mockFindActiveTourneyApprover(...args),
  readTourneySessionFromStore: (...args) =>
    mockReadTourneySessionFromStore(...args),
}));

jest.mock("../server/tourney/playerStore", () => ({
  applyRegistrationDecision: (...args) => mockApplyRegistrationDecision(...args),
  getRegistrationDecisionToken: (...args) =>
    mockGetRegistrationDecisionToken(...args),
  hashTourneyToken: (...args) => mockHashTourneyToken(...args),
}));

jest.mock("../server/tourney/emailDispatch", () => ({
  enqueueTourneyEmailDispatch: (...args) =>
    mockEnqueueTourneyEmailDispatch(...args),
}));

jest.mock("../server/tourney/store", () => ({
  executeTourneyCommand: (...args) => mockExecuteTourneyCommand(...args),
}));

const { GET, POST } = require("../../app/api/tourney/registration-decision/route.js");

const tokenRow = {
  player_id: "player_1",
  recipient_username: "yukari",
  recipient_email: "yukariipoi@gmail.com",
  recipient_role: "caster",
  recipient_version: "1",
};

const approver = {
  username: "yukari",
  role: "caster",
  version: "1",
};

const makeRequest = ({ cookie = "", role = "" } = {}) => ({
  url: `https://www.rooindustries.com/api/tourney/registration-decision?token=abc123&decision=approve${
    role ? `&role=${encodeURIComponent(role)}` : ""
  }`,
  cookies: {
    get: (name) =>
      name === "tourney_session" && cookie ? { value: cookie } : undefined,
  },
});

const makePostRequest = ({ cookie = "", payload = {}, contentLength = "" } = {}) => ({
  url: "https://www.rooindustries.com/api/tourney/registration-decision",
  headers: {
    get: (name) => {
      const key = String(name || "").toLowerCase();
      if (key === "origin") return "https://www.rooindustries.com";
      if (key === "content-type") return "application/json";
      if (key === "content-length") return contentLength;
      return "";
    },
  },
  cookies: {
    get: (name) =>
      name === "tourney_session" && cookie ? { value: cookie } : undefined,
  },
  text: async () => JSON.stringify(payload),
});

describe("tourney registration decision route", () => {
  beforeEach(() => {
    mockFindActiveTourneyApprover.mockReset();
    mockReadTourneySessionFromStore.mockReset();
    mockApplyRegistrationDecision.mockReset();
    mockGetRegistrationDecisionToken.mockReset();
    mockHashTourneyToken.mockClear();
    mockHashTourneyToken.mockImplementation((token) => `hashed:${token}`);
    mockEnqueueTourneyEmailDispatch.mockReset();
    mockExecuteTourneyCommand.mockReset();
    mockExecuteTourneyCommand.mockImplementation(async ({ callback }) => {
      const result = await callback();
      return {
        status: Number(result?.status || 200),
        body: result?.body ?? result,
        syncPending: false,
      };
    });

    mockGetRegistrationDecisionToken.mockResolvedValue(tokenRow);
    mockFindActiveTourneyApprover.mockResolvedValue(approver);
    mockEnqueueTourneyEmailDispatch.mockResolvedValue({ id: "dispatch_1" });
  });

  test("rejects an oversized registration decision body", async () => {
    const response = await POST(makePostRequest({ contentLength: "8193" }));
    expect(response.status).toBe(413);
    expect(mockExecuteTourneyCommand).not.toHaveBeenCalled();
  });

  test("does not approve from a valid token without a matching login session", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue(null);

    const response = await GET(makeRequest());
    const html = await response.text();

    expect(html).toContain("Sign in required");
    expect(mockReadTourneySessionFromStore).toHaveBeenCalledWith({ token: "" });
    expect(mockApplyRegistrationDecision).not.toHaveBeenCalled();
    expect(mockEnqueueTourneyEmailDispatch).not.toHaveBeenCalled();
  });

  test("does not approve from the wrong admin account", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "serviroo",
      role: "owner",
    });

    const response = await GET(makeRequest({ cookie: "owner-session" }));
    const html = await response.text();

    expect(html).toContain("Wrong account");
    expect(mockApplyRegistrationDecision).not.toHaveBeenCalled();
    expect(mockEnqueueTourneyEmailDispatch).not.toHaveBeenCalled();
  });

  test("does not call invalid decision tokens expired", async () => {
    mockGetRegistrationDecisionToken.mockResolvedValue(null);

    const response = await GET(makeRequest());
    const html = await response.text();

    expect(html).toContain("Link unavailable");
    expect(html).not.toContain("Link expired");
    expect(html).not.toContain("expired, or revoked");
    expect(mockApplyRegistrationDecision).not.toHaveBeenCalled();
    expect(mockEnqueueTourneyEmailDispatch).not.toHaveBeenCalled();
  });

  test("approves and emails the player from the assigned approver session", async () => {
    const approvedPlayer = {
      id: "player_1",
      email: "playerone@example.com",
      discord: "PlayerOne#1234",
    };
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockApplyRegistrationDecision.mockResolvedValue(approvedPlayer);

    const response = await GET(makeRequest({ cookie: "caster-session" }));
    const html = await response.text();

    expect(mockApplyRegistrationDecision).toHaveBeenCalledWith({
      tokenHash: "hashed:abc123",
      playerId: "player_1",
      purpose: "approve",
      actorUsername: "yukari",
      approvedRolePlay: "",
    });
    expect(mockEnqueueTourneyEmailDispatch).toHaveBeenCalledWith({
      commandId: "token:hashed:abc123:approve",
      dispatchKind: "approval",
      recipient: "playerone@example.com",
      payload: {
      player: approvedPlayer,
      baseUrl: "https://www.rooindustries.com",
      },
    });
    expect(html).toContain("Approved");
    expect(html).toContain("approval email was queued");
  });

  test("passes the selected approval role from role-specific accept links", async () => {
    const approvedPlayer = {
      id: "player_1",
      email: "playerone@example.com",
      discord: "PlayerOne#1234",
      approvedRolePlay: "Damage",
    };
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockApplyRegistrationDecision.mockResolvedValue(approvedPlayer);

    const response = await GET(
      makeRequest({ cookie: "caster-session", role: "Damage" })
    );
    const html = await response.text();

    expect(mockApplyRegistrationDecision).toHaveBeenCalledWith({
      tokenHash: "hashed:abc123",
      playerId: "player_1",
      purpose: "approve",
      actorUsername: "yukari",
      approvedRolePlay: "Damage",
    });
    expect(mockEnqueueTourneyEmailDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchKind: "approval",
        recipient: "playerone@example.com",
      })
    );
    expect(html).toContain("Approved");
  });

  test("accepts decision credentials in a same-origin POST body", async () => {
    const approvedPlayer = {
      id: "player_1",
      email: "playerone@example.com",
      discord: "PlayerOne#1234",
    };
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockApplyRegistrationDecision.mockResolvedValue(approvedPlayer);

    const response = await POST(
      makePostRequest({
        cookie: "caster-session",
        payload: { token: "abc123", decision: "approve", role: "Support" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, title: "Approved" });
    expect(mockApplyRegistrationDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: "hashed:abc123",
        approvedRolePlay: "Support",
      })
    );
  });

  test("tells the approver to retry when the durable decision lease is busy", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockExecuteTourneyCommand.mockRejectedValue(Object.assign(
      new Error("already processing"),
      { status: 409, code: "TOURNEY_AUTH_OPERATION_IN_PROGRESS" }
    ));

    const response = await POST(makePostRequest({
      cookie: "caster-session",
      payload: { token: "abc123", decision: "approve", role: "Support" },
    }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(body).toMatchObject({
      title: "Still processing",
      code: "TOURNEY_AUTH_OPERATION_IN_PROGRESS",
    });
    expect(body.message).toContain("retry in a few seconds");
  });

  test("returns a conflict for the opposite terminal registration decision", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockApplyRegistrationDecision.mockRejectedValue(Object.assign(
      new Error("The registration already has the opposite decision."),
      { code: "TOURNEY_DECISION_CHANGED", status: 409 }
    ));

    const response = await POST(makePostRequest({
      cookie: "caster-session",
      payload: { token: "abc123", decision: "deny" },
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      title: "Decision conflict",
      code: "TOURNEY_DECISION_CHANGED",
    });
  });

  test("preserves background synchronization state in POST responses", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockApplyRegistrationDecision.mockResolvedValue({
      id: "player_1",
      email: "playerone@example.com",
      discord: "PlayerOne#1234",
    });
    mockExecuteTourneyCommand.mockImplementation(async ({ callback }) => {
      const result = await callback();
      return {
        status: 200,
        body: { ...result.body, syncPending: true },
        syncPending: true,
      };
    });

    const response = await POST(makePostRequest({
      cookie: "caster-session",
      payload: { token: "abc123", decision: "approve", role: "Support" },
    }));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      syncPending: true,
    });
  });

  test("returns a retryable 503 while Tourney writes are paused", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockApplyRegistrationDecision.mockRejectedValue(Object.assign(
      new Error("Tournament updates are briefly paused. Try again shortly."),
      { code: "TOURNEY_WRITES_PAUSED", status: 503, retryAfter: 30 }
    ));
    const response = await POST(makePostRequest({
      cookie: "caster-session",
      payload: { token: "abc123", decision: "approve" },
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      title: "Try again shortly",
      code: "TOURNEY_WRITES_PAUSED",
    });
  });
});
