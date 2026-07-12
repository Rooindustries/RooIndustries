const afterCallbacks = [];
const mockFlushDeferredCommerceMirror = jest.fn();
const mockRecordCommerceResponseMetric = jest.fn();
const mockRunLegacyApiHandler = jest.fn();

jest.mock("next/server", () => ({
  after: (callback) => afterCallbacks.push(callback),
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
}));

jest.mock("../server/booking/holdSlot", () => jest.fn());

const { POST } = require("../../app/api/holdSlot/route.js");

describe("hold route deferred work", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
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

  test("flushes the commerce mirror after every successful hold response", async () => {
    const response = await POST({ method: "POST" });

    expect(response.status).toBe(200);
    expect(afterCallbacks).toHaveLength(2);
    await Promise.all(afterCallbacks.map((callback) => callback()));
    expect(mockFlushDeferredCommerceMirror).toHaveBeenCalledTimes(1);
  });
});
