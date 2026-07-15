const mockInspect = jest.fn();
const mockCapture = jest.fn();
const mockReadChunk = jest.fn();
const mockSeal = jest.fn();

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
jest.mock("../server/tourney/snapshotTransport", () => ({
  inspectSnapshotTransport: (...args) => mockInspect(...args),
  captureSnapshotTransport: (...args) => mockCapture(...args),
  readSnapshotTransportChunk: (...args) => mockReadChunk(...args),
}));
jest.mock("../server/tourney/snapshotTransportCrypto", () => ({
  sealSnapshotTransportPayload: (...args) => mockSeal(...args),
}));

const { POST } = require("../../app/api/admin/tourney-snapshot-transport/route.js");

const secret = "s".repeat(64);
const fingerprints = {
  legacy: "a".repeat(64),
  sanity: "b".repeat(64),
  supabaseApi: "c".repeat(64),
  supabaseDatabase: "d".repeat(64),
};
const request = (body, bearer = secret) => {
  const payload = JSON.stringify({
      requestId: "e".repeat(32),
      publicKey: "public-key",
      ...body,
  });
  return {
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase();
        if (key === "authorization") return `Bearer ${bearer}`;
        if (key === "content-type") return "application/json";
        if (key === "content-length") return String(Buffer.byteLength(payload));
        return "";
      },
    },
    text: async () => payload,
  };
};

describe("Tourney snapshot transport route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = secret;
    mockSeal.mockImplementation(({ metadata }) => ({ sealed: true, metadata }));
  });

  afterAll(() => {
    delete process.env.CRON_SECRET;
  });

  test("hides the route from unauthorized callers", async () => {
    const response = await POST(request({ action: "inspect" }, "wrong"));
    expect(response.status).toBe(404);
    expect(mockInspect).not.toHaveBeenCalled();
  });

  test("inspects targets without requiring the undiscovered database pin", async () => {
    mockInspect.mockResolvedValue({ fingerprints });
    const { supabaseDatabase, ...known } = fingerprints;
    const response = await POST(request({
      action: "inspect",
      expectedTargets: known,
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, envelope: { sealed: true } });
    expect(mockInspect).toHaveBeenCalledWith({ expectedTargets: known });
    expect(JSON.stringify(body)).not.toContain(supabaseDatabase);
  });

  test("returns only sealed capture metadata and sealed bounded chunks", async () => {
    mockCapture.mockResolvedValue({
      snapshotId: "10000000-0000-4000-8000-000000000001",
      payloadSha256: "f".repeat(64),
      totalBytes: 4,
      fingerprints,
      hostedRoundtripVerified: true,
    });
    const captureResponse = await POST(request({
      action: "capture",
      expectedTargets: fingerprints,
    }));
    expect(captureResponse.status).toBe(200);
    expect(mockCapture).toHaveBeenCalledWith({ expectedTargets: fingerprints });

    mockReadChunk.mockResolvedValue({
      chunk: Buffer.from("data"),
      totalBytes: 4,
      fingerprints,
    });
    const chunkResponse = await POST(request({
      action: "chunk",
      expectedTargets: fingerprints,
      snapshotId: "10000000-0000-4000-8000-000000000001",
      payloadSha256: "f".repeat(64),
      offset: 0,
    }));
    const body = await chunkResponse.json();
    expect(chunkResponse.status).toBe(200);
    expect(body).toMatchObject({ ok: true, envelope: { sealed: true } });
    expect(JSON.stringify(body)).not.toContain('"payload":"data"');
    expect(mockSeal).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: Buffer.from("data"),
      metadata: expect.objectContaining({ chunkBytes: 4, totalBytes: 4 }),
    }));
  });
});
