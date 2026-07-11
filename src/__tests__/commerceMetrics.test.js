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

import { recordCommerceResponseMetric } from "../server/supabase/commerceMetrics";

describe("commerce request metrics", () => {
  beforeEach(() => rpc.mockClear());

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
