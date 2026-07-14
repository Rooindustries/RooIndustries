const mockCheckTourneyRateLimit = jest.fn();
const mockCreateTourneySessionToken = jest.fn();
const mockGetClientAddressFromHeaders = jest.fn();
const mockGetTourneyCookieOptions = jest.fn();
const mockVerifyTourneyCredentials = jest.fn();
const mockLogSafeError = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({
      status: init.status || 200,
      json: async () => body,
    }),
    redirect: (url, init = {}) => ({
      status: init.status || 307,
      url: String(url),
    }),
  },
}));

jest.mock("../server/tourney/auth", () => ({
  TOURNEY_SESSION_COOKIE: "tourney_session",
  TOURNEY_REMEMBERED_SESSION_MAX_AGE_SECONDS: 60 * 60 * 24 * 30,
  TOURNEY_SESSION_MAX_AGE_SECONDS: 60 * 60 * 12,
  checkTourneyRateLimit: (...args) => mockCheckTourneyRateLimit(...args),
  createTourneySessionToken: (...args) => mockCreateTourneySessionToken(...args),
  getClientAddressFromHeaders: (...args) => mockGetClientAddressFromHeaders(...args),
  getTourneyCookieOptions: (...args) => mockGetTourneyCookieOptions(...args),
  verifyTourneyCredentials: (...args) => mockVerifyTourneyCredentials(...args),
}));
jest.mock("../server/safeErrorLog", () => ({
  logSafeError: (...args) => mockLogSafeError(...args),
}));

const { POST } = require("../../app/api/tourney/login/route.js");

const makeJsonRequest = (payload) => {
  const body = JSON.stringify(payload);
  return {
    url: "https://www.rooindustries.com/api/tourney/login",
    headers: {
      get: (name) => {
        const normalizedName = String(name || "").toLowerCase();
        if (normalizedName === "accept") return "application/json";
        if (normalizedName === "content-type") return "application/json";
        if (normalizedName === "content-length") return String(Buffer.byteLength(body));
        return "";
      },
    },
    text: async () => body,
  };
};

describe("tourney login API route", () => {
  beforeEach(() => {
    mockCheckTourneyRateLimit.mockReset();
    mockCreateTourneySessionToken.mockReset();
    mockGetClientAddressFromHeaders.mockReset();
    mockGetTourneyCookieOptions.mockReset();
    mockVerifyTourneyCredentials.mockReset();
    mockLogSafeError.mockReset();

    mockCheckTourneyRateLimit.mockReturnValue({ ok: true });
    mockGetClientAddressFromHeaders.mockReturnValue("127.0.0.1");
  });

  test("returns the suspended tourney message for removed players", async () => {
    mockVerifyTourneyCredentials.mockResolvedValue({
      ok: false,
      account: null,
      reason: "suspended",
    });

    const response = await POST(
      makeJsonRequest({
        username: "doggington",
        password: "correct-password",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      ok: false,
      error:
        "You have been suspended from the tourney. Please contact serviroo through Discord or at serviroo@rooindustries.com for further queries.",
    });
  });

  test("safely logs credential verification exceptions", async () => {
    const failure = Object.assign(new Error("database unavailable"), {
      code: "TERRAIN_UNAVAILABLE",
    });
    mockVerifyTourneyCredentials.mockRejectedValue(failure);

    const response = await POST(
      makeJsonRequest({ username: "player-one", password: "private-password" })
    );

    expect(response.status).toBe(503);
    expect(mockLogSafeError).toHaveBeenCalledWith(
      "Tournament login credential verification failed",
      failure
    );
  });
});
