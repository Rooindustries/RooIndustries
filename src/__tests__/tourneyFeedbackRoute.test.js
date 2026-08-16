const mockCheckTourneyRateLimit = jest.fn();
const mockGetClientAddressFromHeaders = jest.fn();
const mockReadTourneySessionFromStore = jest.fn();
const mockCreateTourneyFeedback = jest.fn();
const mockListTourneyFeedbackForSession = jest.fn();
const mockEnqueueTourneyEmailDispatch = jest.fn();
const mockExecuteTourneyCommand = jest.fn();
const mockReadTourneyCommandId = jest.fn();
const originalResponseJson = Response.json;
const originalFeedbackSlug = process.env.TOURNEY_FEEDBACK_SLUG;
const feedbackSlug = "participants-private-feedback-link";

if (!Response.json) {
  Response.json = (body, init = {}) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
}

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({
      status: init.status || 200,
      json: async () => body,
      headers: { set: jest.fn(), ...(init.headers || {}) },
    }),
  },
}));

jest.mock("../server/tourney/auth", () => ({
  TOURNEY_SESSION_COOKIE: "tourney_session",
  checkTourneyRateLimit: (...args) => mockCheckTourneyRateLimit(...args),
  getClientAddressFromHeaders: (...args) => mockGetClientAddressFromHeaders(...args),
  readTourneySessionFromStore: (...args) => mockReadTourneySessionFromStore(...args),
}));

jest.mock("../server/tourney/feedbackStore", () => ({
  createTourneyFeedback: (...args) => mockCreateTourneyFeedback(...args),
  listTourneyFeedbackForSession: (...args) =>
    mockListTourneyFeedbackForSession(...args),
}));

jest.mock("../server/tourney/emailDispatch", () => ({
  enqueueTourneyEmailDispatch: (...args) =>
    mockEnqueueTourneyEmailDispatch(...args),
}));

jest.mock("../server/request/sameOrigin", () => ({
  isSameOriginMutation: () => true,
}));

jest.mock("../server/tourney/store", () => ({
  executeTourneyCommand: (...args) => mockExecuteTourneyCommand(...args),
  readTourneyCommandId: (...args) => mockReadTourneyCommandId(...args),
}));

const feedbackRoute = require("../../app/api/tourney/feedback/route.js");

const makeJsonRequest = (payload = {}, cookie = "", slug = feedbackSlug) => {
  const raw = JSON.stringify(payload);
  return {
    url: "https://www.rooindustries.com/api/tourney/feedback",
    headers: {
      get: (name) => {
        const normalized = String(name || "").toLowerCase();
        if (normalized === "content-type") return "application/json";
        if (normalized === "content-length") return String(Buffer.byteLength(raw));
        if (normalized === "x-tourney-feedback-slug") return slug;
        return "";
      },
    },
    cookies: {
      get: (name) =>
        name === "tourney_session" && cookie ? { value: cookie } : undefined,
    },
    json: async () => payload,
    text: async () => raw,
  };
};

const validPayload = {
  overallRating: 5,
  organizationRating: 4,
  communicationRating: 4,
  formatRating: 5,
  returnIntent: "yes",
  feedbackText: "Share schedules earlier.",
};

describe("anonymous Tourney participant feedback route", () => {
  afterAll(() => {
    if (originalResponseJson) {
      Response.json = originalResponseJson;
    } else {
      delete Response.json;
    }
    if (originalFeedbackSlug === undefined) {
      delete process.env.TOURNEY_FEEDBACK_SLUG;
    } else {
      process.env.TOURNEY_FEEDBACK_SLUG = originalFeedbackSlug;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TOURNEY_FEEDBACK_SLUG = feedbackSlug;
    mockReadTourneySessionFromStore.mockResolvedValue(null);
    mockGetClientAddressFromHeaders.mockReturnValue("127.0.0.1");
    mockCheckTourneyRateLimit.mockResolvedValue({ ok: true });
    mockReadTourneyCommandId.mockReturnValue("feedback-command-0001");
    mockCreateTourneyFeedback.mockResolvedValue({
      id: "feedback-1",
      ...validPayload,
      createdAt: "2026-08-17T12:00:00.000Z",
    });
    mockListTourneyFeedbackForSession.mockResolvedValue([]);
    mockEnqueueTourneyEmailDispatch.mockResolvedValue({ id: "dispatch-1" });
    mockExecuteTourneyCommand.mockImplementation(async ({ callback }) => {
      const result = await callback();
      return { status: 200, body: result.body };
    });
  });

  test("keeps the response list private to organisers", async () => {
    const response = await feedbackRoute.GET(makeJsonRequest());

    expect(response.status).toBe(404);
    expect(mockListTourneyFeedbackForSession).not.toHaveBeenCalled();
  });

  test("accepts anonymous feedback without a login or participant identity", async () => {
    const response = await feedbackRoute.POST(makeJsonRequest(validPayload));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      receiptId: "feedback-1",
      feedback: { id: "feedback-1" },
    });
    expect(mockReadTourneySessionFromStore).not.toHaveBeenCalled();
    expect(mockCreateTourneyFeedback).toHaveBeenCalledWith({ payload: validPayload });
    expect(mockEnqueueTourneyEmailDispatch).toHaveBeenCalledWith({
      commandId: "feedback-command-0001",
      dispatchKind: "feedback",
      recipient: "serviroo@rooindustries.com",
      idempotencyKey: "anonymous-feedback-owner",
      entityType: "feedback",
      entityId: "feedback-1",
      entityVersion: "2026-08-17T12:00:00.000Z",
      audience: "owner",
      payload: {
        feedback: {
          id: "feedback-1",
          ...validPayload,
          createdAt: "2026-08-17T12:00:00.000Z",
        },
        to: "serviroo@rooindustries.com",
      },
    });
    expect(mockCheckTourneyRateLimit).toHaveBeenCalledWith({
      key: "tourney-feedback:127.0.0.1",
      max: 10,
      windowMs: 60 * 60 * 1000,
    });
    expect(mockExecuteTourneyCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandId: "feedback-command-0001",
      purpose: "appeals:anonymous-feedback",
      requestPayload: validPayload,
    }));
  });

  test("hides the submission endpoint without the participant link slug", async () => {
    const response = await feedbackRoute.POST(makeJsonRequest(validPayload, "", ""));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Not found.");
    expect(mockCheckTourneyRateLimit).not.toHaveBeenCalled();
    expect(mockCreateTourneyFeedback).not.toHaveBeenCalled();
  });

  test("rejects any team-specific slug instead of creating alternate links", async () => {
    const response = await feedbackRoute.POST(
      makeJsonRequest(validPayload, "", `${feedbackSlug}-team-one`)
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Not found.");
    expect(mockCreateTourneyFeedback).not.toHaveBeenCalled();
  });

  test("rate limits repeated anonymous feedback attempts by address", async () => {
    mockCheckTourneyRateLimit.mockResolvedValue({
      ok: false,
      status: 429,
      retryAfterSeconds: 60,
    });

    const response = await feedbackRoute.POST(makeJsonRequest(validPayload));
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.error).toContain("Too many feedback attempts");
    expect(mockCreateTourneyFeedback).not.toHaveBeenCalled();
  });
});
