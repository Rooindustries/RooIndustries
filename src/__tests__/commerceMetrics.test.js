const rpc = jest.fn().mockResolvedValue({ data: null, error: null });

jest.mock("../server/supabase/adminClient", () => ({
  createSupabaseAdminClient: () => ({ rpc }),
  isSupabaseAdminConfigured: () => true,
}));

jest.mock("../server/supabase/runtime", () => ({
  resolveSupabaseRuntimePolicy: () => ({
    commercePrimaryBackend: "supabase",
    commerceFailoverGeneration: 3,
  }),
}));

import { recordCommerceMetric, recordCommerceResponseMetric } from "../server/supabase/commerceMetrics";

describe("commerce request metrics", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    rpc.mockClear();
    process.env = { ...originalEnv };
  });

  afterEach(() => { process.env = originalEnv; });

  test("does not write metrics from a read-only preview", async () => {
    process.env.SALES_PREVIEW_READ_ONLY = "1";
    process.env.VERCEL_ENV = "preview";
    await recordCommerceMetric({ route: "booking/availability", durationMs: 12, statusCode: 200 });
    expect(rpc).not.toHaveBeenCalled();
  });

  test("continues recording production metrics when the preview flag is present", async () => {
    process.env.SALES_PREVIEW_READ_ONLY = "1";
    process.env.VERCEL_ENV = "production";
    await recordCommerceMetric({ route: "booking/availability", durationMs: 12, statusCode: 200 });
    expect(rpc).toHaveBeenCalledWith("roo_record_commerce_metric", expect.objectContaining({ p_route: "booking/availability", p_status_code: 200 }));
  });

  test("measures a response body even when Content-Length is absent", async () => {
    const body = JSON.stringify({ ok: true, value: "measured" });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await recordCommerceResponseMetric({
      route: "payment/status",
      durationMs: 42.4,
      statusCode: 200,
      response,
    });

    expect(rpc).toHaveBeenCalledWith("roo_record_commerce_metric", {
      p_route: "payment/status",
      p_backend: "supabase",
      p_cutover_generation: 3,
      p_duration_ms: 42,
      p_status_code: 200,
      p_response_bytes: Buffer.byteLength(body),
    });
  });
});
