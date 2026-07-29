const mockCheckTourneyRateLimit = jest.fn();
const mockGetClientAddressFromHeaders = jest.fn();
const mockReadTourneySessionFromStore = jest.fn();
const mockBookTourneyFreeSession = jest.fn();
const mockCancelTourneyFreeSessionBooking = jest.fn();
const mockGetTourneyFreeSessionState = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({
      status: init.status || 200,
      headers: new Headers(init.headers || {}),
      json: async () => body,
    }),
  },
}));

jest.mock("../server/tourney/auth", () => ({
  TOURNEY_SESSION_COOKIE: "tourney_session",
  checkTourneyRateLimit: (...args) => mockCheckTourneyRateLimit(...args),
  getClientAddressFromHeaders: (...args) =>
    mockGetClientAddressFromHeaders(...args),
  readTourneySessionFromStore: (...args) =>
    mockReadTourneySessionFromStore(...args),
}));

jest.mock("../server/tourney/freeSessionStore", () => ({
  bookTourneyFreeSession: (...args) => mockBookTourneyFreeSession(...args),
  cancelTourneyFreeSessionBooking: (...args) =>
    mockCancelTourneyFreeSessionBooking(...args),
  getTourneyFreeSessionState: (...args) =>
    mockGetTourneyFreeSessionState(...args),
}));

const route = require("../../app/api/tourney/free-session/route.js");
const {
  resetMemoryTourneyControlForTests,
} = require("../server/tourney/store.js");

const availableState = {
  ok: true,
  packageTitle: "Tourney Free Optimization",
  availabilityUrl: "/api/bookingAvailability",
  entitlement: {
    id: "entitlement-1",
    status: "available",
    bookingId: "",
    consumedAt: "",
    booking: null,
  },
};

const consumedState = {
  ok: true,
  packageTitle: "Tourney Free Optimization",
  availabilityUrl: "/api/bookingAvailability",
  entitlement: {
    id: "entitlement-1",
    status: "consumed",
    bookingId: "10000000-0000-4000-8000-000000000001",
    consumedAt: "2026-07-30T08:00:00.000Z",
    booking: {
      id: "10000000-0000-4000-8000-000000000001",
      startTimeUTC: "2026-08-01T08:00:00.000Z",
      status: "captured",
    },
  },
};

const bookingPayload = {
  action: "book",
  startTimeUTC: "2026-08-01T08:00:00.000Z",
  email: "player@example.com",
  discord: "PlayerOne#1234",
  specs: "Ryzen 7 / RTX 4070",
  mainGame: "Overwatch 2",
  timezone: "Asia/Kolkata",
};

const makeRequest = ({
  payload = {},
  cookie = "player-session",
  origin = "https://www.rooindustries.com",
  idempotencyKey = "free-session-route-0001",
  query = "",
} = {}) => {
  const raw = JSON.stringify(payload);
  return {
    url: `https://www.rooindustries.com/api/tourney/free-session${query}`,
    headers: {
      get: (name) => {
        const normalized = String(name || "").toLowerCase();
        if (normalized === "content-type") return "application/json";
        if (normalized === "content-length") {
          return String(Buffer.byteLength(raw));
        }
        if (normalized === "origin") return origin;
        if (normalized === "sec-fetch-site") return "same-origin";
        if (normalized === "idempotency-key") return idempotencyKey;
        return "";
      },
    },
    cookies: {
      get: (name) =>
        name === "tourney_session" && cookie ? { value: cookie } : undefined,
    },
    text: async () => raw,
  };
};

const responseBody = (response) => response.json();

describe("Tourney free-session route", () => {
  beforeEach(() => {
    resetMemoryTourneyControlForTests();
    mockCheckTourneyRateLimit.mockReset();
    mockGetClientAddressFromHeaders.mockReset();
    mockReadTourneySessionFromStore.mockReset();
    mockBookTourneyFreeSession.mockReset();
    mockCancelTourneyFreeSessionBooking.mockReset();
    mockGetTourneyFreeSessionState.mockReset();

    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "player-one",
      role: "player",
      playerId: "player-1",
    });
    mockGetClientAddressFromHeaders.mockReturnValue("203.0.113.8");
    mockCheckTourneyRateLimit.mockResolvedValue({ ok: true });
    mockGetTourneyFreeSessionState.mockResolvedValue(availableState);
    mockBookTourneyFreeSession.mockResolvedValue({
      body: consumedState,
      compensation: {
        bookingReference: "booking.tourney-free-session",
        backend: "supabase",
      },
    });
    mockCancelTourneyFreeSessionBooking.mockResolvedValue();
  });

  test("hides the entitlement from logged-out users and viewers", async () => {
    mockReadTourneySessionFromStore.mockResolvedValueOnce(null);
    const loggedOut = await route.GET(makeRequest({ cookie: "" }));

    mockReadTourneySessionFromStore.mockResolvedValueOnce({
      username: "viewer-one",
      role: "viewer",
    });
    const viewer = await route.GET(makeRequest({ cookie: "viewer-session" }));

    expect(loggedOut.status).toBe(404);
    await expect(responseBody(loggedOut)).resolves.toMatchObject({
      ok: false,
      error: "Not found.",
    });
    expect(viewer.status).toBe(404);
    expect(mockGetTourneyFreeSessionState).not.toHaveBeenCalled();
  });

  test("returns available and consumed entitlement states for a player", async () => {
    const available = await route.GET(makeRequest());
    expect(available.status).toBe(200);
    await expect(responseBody(available)).resolves.toEqual(availableState);
    expect(mockGetTourneyFreeSessionState).toHaveBeenLastCalledWith({
      playerId: "player-1",
    });

    mockGetTourneyFreeSessionState.mockResolvedValueOnce(consumedState);
    const consumed = await route.GET(makeRequest());
    expect(consumed.status).toBe(200);
    await expect(responseBody(consumed)).resolves.toEqual(consumedState);
  });

  test("allows owner and caster support reads for an explicit player", async () => {
    mockReadTourneySessionFromStore.mockResolvedValueOnce({
      username: "serviroo",
      role: "owner",
    });
    await route.GET(makeRequest({ query: "?playerId=player-2" }));

    mockReadTourneySessionFromStore.mockResolvedValueOnce({
      username: "caster-one",
      role: "caster",
    });
    await route.GET(makeRequest({ query: "?playerId=player-3" }));

    expect(mockGetTourneyFreeSessionState).toHaveBeenNthCalledWith(1, {
      playerId: "player-2",
    });
    expect(mockGetTourneyFreeSessionState).toHaveBeenNthCalledWith(2, {
      playerId: "player-3",
    });
  });

  test("books once and replays the same idempotent command", async () => {
    const first = await route.POST(makeRequest({ payload: bookingPayload }));
    const replay = await route.POST(makeRequest({ payload: bookingPayload }));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(responseBody(first)).resolves.toEqual(consumedState);
    await expect(responseBody(replay)).resolves.toEqual(consumedState);
    expect(mockBookTourneyFreeSession).toHaveBeenCalledTimes(1);
    expect(mockBookTourneyFreeSession).toHaveBeenCalledWith({
      session: {
        username: "player-one",
        role: "player",
        playerId: "player-1",
      },
      payload: bookingPayload,
      clientAddress: "203.0.113.8",
    });
    expect(mockCancelTourneyFreeSessionBooking).not.toHaveBeenCalled();
  });

  test("returns a clean slot conflict without consuming the entitlement", async () => {
    mockBookTourneyFreeSession.mockRejectedValueOnce(
      Object.assign(new Error("This slot is already booked."), {
        status: 409,
        code: "TOURNEY_FREE_SESSION_SLOT_CONFLICT",
      })
    );

    const response = await route.POST(
      makeRequest({
        payload: bookingPayload,
        idempotencyKey: "free-session-route-0002",
      })
    );

    expect(response.status).toBe(409);
    await expect(responseBody(response)).resolves.toMatchObject({
      ok: false,
      error: "This slot is already booked.",
      code: "TOURNEY_FREE_SESSION_SLOT_CONFLICT",
    });
    expect(mockCancelTourneyFreeSessionBooking).not.toHaveBeenCalled();
  });

  test("rejects missing and non-approved player sessions", async () => {
    mockReadTourneySessionFromStore.mockResolvedValueOnce(null);
    const missing = await route.POST(
      makeRequest({
        payload: bookingPayload,
        cookie: "",
        idempotencyKey: "free-session-route-0003",
      })
    );
    expect(missing.status).toBe(404);

    mockReadTourneySessionFromStore.mockResolvedValueOnce({
      username: "pending-player",
      role: "player",
      playerId: "pending-player-1",
    });
    mockBookTourneyFreeSession.mockRejectedValueOnce(
      Object.assign(new Error("Not found."), { status: 404 })
    );
    const pending = await route.POST(
      makeRequest({
        payload: bookingPayload,
        idempotencyKey: "free-session-route-0004",
      })
    );

    expect(pending.status).toBe(404);
    await expect(responseBody(pending)).resolves.toMatchObject({
      ok: false,
      error: "Not found.",
    });
  });

  test("enforces same-origin mutations", async () => {
    const response = await route.POST(
      makeRequest({
        payload: bookingPayload,
        origin: "https://attacker.example",
        idempotencyKey: "free-session-route-0005",
      })
    );

    expect(response.status).toBe(403);
    expect(mockBookTourneyFreeSession).not.toHaveBeenCalled();
  });
});
