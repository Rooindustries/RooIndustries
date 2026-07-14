const mockInventory = jest.fn();
const mockApply = jest.fn();
const mockActivateSchema = jest.fn();
const mockCaptureLatencyBaseline = jest.fn();
const mockReadCutoverState = jest.fn();
const mockSetWritesPaused = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({
      status: init.status || 200,
      headers: init.headers || {},
      json: async () => body,
    }),
  },
}));
jest.mock("../server/safeErrorLog", () => ({ logSafeError: jest.fn() }));
jest.mock("../server/tourney/activation", () => ({
  activateTourneySchemaV4: (...args) => mockActivateSchema(...args),
  captureTourneyLatencyBaselineV4: (...args) => mockCaptureLatencyBaseline(...args),
  inventoryTourneyV4Activation: (...args) => mockInventory(...args),
  applyTourneyV4Activation: (...args) => mockApply(...args),
}));
jest.mock("../server/tourney/cutoverControl", () => ({
  readTourneyDualDatabaseCutoverState: (...args) => mockReadCutoverState(...args),
  setTourneyDualDatabaseWritesPausedV4: (...args) => mockSetWritesPaused(...args),
}));

const { POST } = require("../../app/api/admin/tourney-activation/route.js");
const originalSecret = process.env.CRON_SECRET;
const request = ({ secret = "activation-secret", payload = {}, contentLength = "" } = {}) => ({
  headers: {
    get: (name) => {
      const key = String(name).toLowerCase();
      if (key === "authorization") return `Bearer ${secret}`;
      if (key === "content-type") return "application/json";
      if (key === "content-length") return contentLength;
      return "";
    },
  },
  text: async () => JSON.stringify(payload),
});

describe("Tourney activation route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "activation-secret";
    mockInventory.mockResolvedValue({
      dryRun: true,
      inventoryHash: "a".repeat(64),
      counts: { linked: 4, unknown: 0 },
    });
    mockApply.mockResolvedValue({ applied: true });
    mockActivateSchema.mockResolvedValue({ activated: true, schemaVersion: 4 });
    mockCaptureLatencyBaseline.mockResolvedValue({ captured: 5 });
    mockReadCutoverState.mockResolvedValue({
      controls: {
        legacy: { primaryBackend: "supabase", generation: 1, writesPaused: false },
        supabase: { primaryBackend: "supabase", generation: 1, writesPaused: false },
      },
      fingerprints: { legacy: "a".repeat(64), supabase: "b".repeat(64) },
    });
    mockSetWritesPaused.mockResolvedValue({ changed: true, replayed: false });
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  test("hides the activation endpoint from unauthorized requests", async () => {
    const response = await POST(request({ secret: "wrong", payload: { action: "inventory" } }));
    expect(response.status).toBe(404);
    expect(mockInventory).not.toHaveBeenCalled();
  });

  test("rejects an oversized activation request", async () => {
    const response = await POST(request({ contentLength: "4097" }));
    expect(response.status).toBe(413);
    expect(mockInventory).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  test("returns a non-PII inventory gate", async () => {
    const response = await POST(request({ payload: { action: "inventory" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      dryRun: true,
      inventoryHash: "a".repeat(64),
      counts: { linked: 4, unknown: 0 },
    });
  });

  test("passes the exact inventory hash to activation apply", async () => {
    const inventoryHash = "b".repeat(64);
    const response = await POST(request({
      payload: { action: "apply", inventoryHash },
    }));
    expect(response.status).toBe(200);
    expect(mockApply).toHaveBeenCalledWith({ inventoryHash });
  });

  test("activates the already-installed Supabase schema only through the explicit action", async () => {
    const response = await POST(request({ payload: { action: "activate-schema" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      activated: true,
      schemaVersion: 4,
    });
    expect(mockActivateSchema).toHaveBeenCalledWith();
    expect(mockInventory).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  test("captures the audited pre-activation latency baseline explicitly", async () => {
    const response = await POST(request({
      payload: { action: "capture-latency-baseline" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, captured: 5 });
    expect(mockCaptureLatencyBaseline).toHaveBeenCalledWith();
  });

  test("returns read-only dual cutover state for fingerprinted operator calls", async () => {
    const response = await POST(request({ payload: { action: "cutover-state" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      controls: {
        legacy: { primaryBackend: "supabase", writesPaused: false },
        supabase: { primaryBackend: "supabase", writesPaused: false },
      },
      fingerprints: { legacy: "a".repeat(64), supabase: "b".repeat(64) },
    });
    expect(mockReadCutoverState).toHaveBeenCalledWith();
    expect(mockSetWritesPaused).not.toHaveBeenCalled();
  });

  test.each([
    ["pause-writes", false, true],
    ["resume-writes", true, false],
  ])("passes an exact expected state to %s", async (
    action,
    expectedWritesPaused,
    writesPaused
  ) => {
    const response = await POST(request({
      payload: {
        action,
        operationId: `${action}-20260715t000000z`,
        expectedPrimaryBackend: "supabase",
        expectedGeneration: 1,
        expectedWritesPaused,
        legacyTargetFingerprint: "a".repeat(64),
        supabaseTargetFingerprint: "b".repeat(64),
      },
    }));

    expect(response.status).toBe(200);
    expect(mockSetWritesPaused).toHaveBeenCalledWith({
      operationId: `${action}-20260715t000000z`,
      expectedPrimaryBackend: "supabase",
      expectedGeneration: 1,
      expectedWritesPaused,
      legacyTargetFingerprint: "a".repeat(64),
      writesPaused,
      supabaseTargetFingerprint: "b".repeat(64),
    });
  });
});
