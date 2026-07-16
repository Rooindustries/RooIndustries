const afterCallbacks = [];
const mockFlushDeferredCommerceMirror = jest.fn();
const mockRecordCommerceResponseMetric = jest.fn();
const mockRunLegacyApiHandler = jest.fn();
let mockMirrorEnabled = true;
let afterRegistrationError = null;

jest.mock("next/server", () => ({
  after: (callback) => {
    if (afterRegistrationError) throw afterRegistrationError;
    afterCallbacks.push(callback);
  },
}));

jest.mock("../lib/nextApiAdapter", () => ({
  runLegacyApiHandler: (...args) => mockRunLegacyApiHandler(...args),
}));

jest.mock("../server/supabase/commerceMetrics", () => ({
  recordCommerceResponseMetric: (...args) =>
    mockRecordCommerceResponseMetric(...args),
}));

jest.mock("../server/supabase/deferredCommerceMirror", () => ({
  flushDeferredCommerceMirror: (...args) =>
    mockFlushDeferredCommerceMirror(...args),
  isDeferredCommerceMirrorEnabled: () => mockMirrorEnabled,
}));

jest.mock("../server/booking/holdSlot", () => jest.fn());

const { POST } = require("../../app/api/holdSlot/route.js");

describe("hold route deferred work", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    mockMirrorEnabled = true;
    afterRegistrationError = null;
    mockFlushDeferredCommerceMirror.mockReset().mockResolvedValue({
      supported: true,
      attempted: 1,
      mirrored: 1,
      failed: 0,
    });
    mockRecordCommerceResponseMetric.mockReset().mockResolvedValue(undefined);
    mockRunLegacyApiHandler.mockReset().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  });

  test("flushes after a successful configured Supabase-primary hold", async () => {
    const response = await POST({ method: "POST" });

    expect(response.status).toBe(200);
    expect(afterCallbacks).toHaveLength(2);
    await Promise.all(afterCallbacks.map((callback) => callback()));
    expect(mockFlushDeferredCommerceMirror).toHaveBeenCalledTimes(1);
  });

  test("skips the flush when Sanity is unconfigured", async () => {
    mockMirrorEnabled = false;

    const response = await POST({ method: "POST" });

    expect(response.status).toBe(200);
    await Promise.all(afterCallbacks.map((callback) => callback()));
    expect(mockFlushDeferredCommerceMirror).not.toHaveBeenCalled();
  });

  test("skips the flush after a failed primary response", async () => {
    mockRunLegacyApiHandler.mockResolvedValueOnce(
      Response.json({ ok: false }, { status: 500 })
    );

    const response = await POST({ method: "POST" });

    expect(response.status).toBe(500);
    await Promise.all(afterCallbacks.map((callback) => callback()));
    expect(mockFlushDeferredCommerceMirror).not.toHaveBeenCalled();
  });

  test("keeps the successful primary response when deferred scheduling fails", async () => {
    afterRegistrationError = new Error("deferred scheduler unavailable");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const response = await POST({ method: "POST" });

      expect(response.status).toBe(200);
      expect(mockFlushDeferredCommerceMirror).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "event=sanity_mirror_lag reason=deferred_schedule_failed domain=commerce"
      );
    } finally {
      warn.mockRestore();
    }
  });
});
