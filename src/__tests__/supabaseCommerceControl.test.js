import {
  assertCommerceStartAllowed,
  assertCommerceWriteAllowed,
  getCommerceControl,
} from "../server/supabase/commerceControl";

const supabaseEnv = (overrides = {}) => ({
  NODE_ENV: "test",
  DATA_PRIMARY_BACKEND: "sanity",
  COMMERCE_PRIMARY_BACKEND: "supabase",
  COMMERCE_CUTOVER_ENABLED: "1",
  SANITY_REVERSE_MIRROR_WRITES: "1",
  COMMERCE_FAILOVER_GENERATION: "4",
  ...overrides,
});

describe("Supabase commerce control plane", () => {
  test("accepts a matching unpaused database generation", async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          primary_backend: "supabase",
          generation: 4,
          starts_paused: false,
        },
        error: null,
      }),
    };
    await expect(
      assertCommerceStartAllowed({ env: supabaseEnv(), client })
    ).resolves.toMatchObject({
      primaryBackend: "supabase",
      generation: 4,
      startsPaused: false,
    });
  });

  test.each([
    ["stale generation", { primary_backend: "supabase", generation: 3, starts_paused: false }, "COMMERCE_GENERATION_STALE"],
    ["wrong primary", { primary_backend: "sanity", generation: 4, starts_paused: false }, "COMMERCE_PRIMARY_MISMATCH"],
    ["database pause", { primary_backend: "supabase", generation: 4, starts_paused: true }, "COMMERCE_STARTS_PAUSED"],
  ])("fails closed for %s", async (_name, data, code) => {
    const client = { rpc: jest.fn().mockResolvedValue({ data, error: null }) };
    await expect(
      assertCommerceStartAllowed({ env: supabaseEnv(), client })
    ).rejects.toMatchObject({ code, status: 503 });
  });

  test("does not contact Supabase while Sanity is primary", async () => {
    const client = { rpc: jest.fn() };
    await expect(
      assertCommerceStartAllowed({
        env: { NODE_ENV: "test", COMMERCE_PRIMARY_BACKEND: "sanity" },
        client,
      })
    ).resolves.toMatchObject({ primaryBackend: "sanity" });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  test("blocks all ordinary writes during a deployment pause", async () => {
    const client = { rpc: jest.fn() };
    await expect(
      assertCommerceWriteAllowed({
        env: {
          NODE_ENV: "test",
          COMMERCE_PRIMARY_BACKEND: "sanity",
          COMMERCE_STARTS_PAUSED: "1",
        },
        client,
      })
    ).rejects.toMatchObject({ code: "COMMERCE_STARTS_PAUSED", status: 503 });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  test("fails closed when the control RPC is unavailable", async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: null,
        error: { code: "PGRST202" },
      }),
    };
    await expect(getCommerceControl({ client })).rejects.toMatchObject({
      code: "COMMERCE_CONTROL_UNAVAILABLE",
      status: 503,
    });
  });
});
