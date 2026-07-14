const mockRunTourneyReconciliation = jest.fn();
const mockLogSafeError = jest.fn();
const mockRepairTourneyEmailDispatch = jest.fn();
const mockRepairTourneyExternalOperation = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({
      status: init.status || 200,
      headers: init.headers || {},
      json: async () => body,
    }),
  },
}));
jest.mock("../server/safeErrorLog", () => ({
  getSafeErrorCode: (error, fallback) => String(error?.code || fallback),
  logSafeError: (...args) => mockLogSafeError(...args),
}));
jest.mock("../server/tourney/reconcile", () => ({
  TOURNEY_RECONCILIATION_BUDGET_MS: 270_000,
  runTourneyReconciliation: (...args) => mockRunTourneyReconciliation(...args),
}));
jest.mock("../server/tourney/emailDispatch", () => ({
  repairTourneyEmailDispatch: (...args) => mockRepairTourneyEmailDispatch(...args),
}));
jest.mock("../server/tourney/externalOperations", () => ({
  repairTourneyExternalOperation: (...args) => mockRepairTourneyExternalOperation(...args),
}));

const route = require("../../app/api/tourney/reconcile/route.js");
const vercel = require("../../vercel.json");
const originalSecret = process.env.CRON_SECRET;

const request = (authorization = "Bearer tourney-cron-secret") => ({
  headers: {
    get: (name) => String(name).toLowerCase() === "authorization"
      ? authorization
      : "",
  },
});
const postRequest = (payload, authorization = "Bearer tourney-cron-secret") => {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    headers: {
      get: (name) => {
        const normalized = String(name).toLowerCase();
        if (normalized === "authorization") return authorization;
        if (normalized === "content-type") return "application/json";
        if (normalized === "content-length") return String(Buffer.byteLength(body));
        return "";
      },
    },
    text: async () => body,
  };
};

describe("Tourney reconciliation cron route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "tourney-cron-secret";
    mockRunTourneyReconciliation.mockResolvedValue({
      skipped: false,
      durationMs: 25,
      summary: { tourneyMirror: { applied: 2, failed: 0 } },
    });
    mockRepairTourneyExternalOperation.mockResolvedValue({
      previousStatus: "dead_letter",
      status: "pending",
      targetHash: "a".repeat(64),
    });
    mockRepairTourneyEmailDispatch.mockResolvedValue({
      previousStatus: "failed",
      status: "pending",
      targetHash: "b".repeat(64),
    });
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  test("rejects requests without Vercel Cron bearer authorization", async () => {
    const response = await route.GET(request(""));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Tournament reconciliation is temporarily unavailable.",
    });
    expect(mockRunTourneyReconciliation).not.toHaveBeenCalled();
  });

  test("runs the dedicated reconciliation budget without a custom scope header", async () => {
    const response = await route.GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      skipped: false,
      durationMs: 25,
      summary: { tourneyMirror: { applied: 2, failed: 0 } },
    });
    expect(mockRunTourneyReconciliation).toHaveBeenCalledWith({
      budgetMs: 270_000,
    });
  });

  test("returns the failed stage and partial summary with a failing status", async () => {
    mockRunTourneyReconciliation.mockRejectedValue(Object.assign(
      new Error("parity failed"),
      {
        status: 503,
        code: "TOURNEY_PARITY_FAILED",
        failedStage: "tourneyParity",
        partialSummary: { tourneyMirror: { applied: 4, failed: 0 } },
      }
    ));

    const response = await route.GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Tournament reconciliation is temporarily unavailable.",
      code: "TOURNEY_PARITY_FAILED",
      failedStage: "tourneyParity",
      summary: { tourneyMirror: { applied: 4, failed: 0 } },
    });
    expect(mockLogSafeError).toHaveBeenCalledTimes(1);
  });

  test("shares the existing five-minute scheduler instead of adding a second cron", () => {
    expect(route.maxDuration).toBe(300);
    expect(vercel.crons).not.toContainEqual(expect.objectContaining({
      path: "/api/tourney/reconcile",
    }));
    expect(vercel.crons).toContainEqual({
      path: "/api/payment/reconcile",
      schedule: "*/5 * * * *",
    });
  });

  test("rejects unauthorized repair commands before parsing or mutating", async () => {
    const response = await route.POST(postRequest({ action: "anything" }, ""));

    expect(response.status).toBe(403);
    expect(mockRepairTourneyExternalOperation).not.toHaveBeenCalled();
    expect(mockRepairTourneyEmailDispatch).not.toHaveBeenCalled();
  });

  test("validates exact action-specific repair payloads", async () => {
    const response = await route.POST(postRequest({
      action: "rearm_external_operation",
      actor: "ops_console",
      reason: "verified_provider_recovery",
      operationKey: "command-00000001:supabase_identity_unlink:player:1",
      surprise: true,
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "TOURNEY_REPAIR_REQUEST_INVALID",
    });
    expect(mockRepairTourneyExternalOperation).not.toHaveBeenCalled();
  });

  test("queues an authorized external-operation repair without running the provider", async () => {
    const command = {
      action: "rearm_external_operation",
      actor: "ops_console",
      reason: "verified_provider_recovery",
      operationKey: "command-00000001:discord_role_reconcile:player:1",
    };
    const response = await route.POST(postRequest(command));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      action: command.action,
      audited: true,
      previousStatus: "dead_letter",
      status: "pending",
      targetHash: "a".repeat(64),
    });
    expect(mockRepairTourneyExternalOperation).toHaveBeenCalledWith(command);
    expect(mockRunTourneyReconciliation).not.toHaveBeenCalled();
  });

  test("passes an explicit historical email override to the audited helper", async () => {
    const command = {
      action: "rearm_email_dispatch",
      actor: "ops_console",
      reason: "delivery_authorized",
      dispatchId: "123e4567-e89b-42d3-a456-426614174000",
      historicalOverride: true,
    };
    const response = await route.POST(postRequest(command));

    expect(response.status).toBe(200);
    expect(mockRepairTourneyEmailDispatch).toHaveBeenCalledWith(command);
  });

  test("returns the pause-control rejection without attempting reconciliation", async () => {
    mockRepairTourneyExternalOperation.mockRejectedValue(Object.assign(
      new Error("writes not paused"),
      { code: "TOURNEY_REPAIR_WRITES_NOT_PAUSED", status: 409 }
    ));
    const response = await route.POST(postRequest({
      action: "rearm_external_operation",
      actor: "ops_console",
      reason: "verified_provider_recovery",
      operationKey: "command-00000001:discord_membership:player:1",
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "TOURNEY_REPAIR_WRITES_NOT_PAUSED",
    });
    expect(mockRunTourneyReconciliation).not.toHaveBeenCalled();
  });
});
