import {
  assertCommerceStartAllowed,
  assertCommerceWriteAllowed,
  getCommerceControl,
} from "../server/supabase/commerceControl";
import {
  issueCommerceFailoverLease,
  verifyCommerceFailoverLease,
} from "../server/supabase/commerceFailoverLease";

const nowSeconds = 2_000_000_000;
const leaseSecret = "commerce-failover-lease-test-secret-1234567890";

const supabaseEnv = (overrides = {}) => ({
  NODE_ENV: "test",
  DATA_PRIMARY_BACKEND: "sanity",
  COMMERCE_PRIMARY_BACKEND: "supabase",
  COMMERCE_CUTOVER_ENABLED: "1",
  SANITY_REVERSE_MIRROR_WRITES: "1",
  COMMERCE_FAILOVER_GENERATION: "4",
  ...overrides,
});

const sanityEnv = (envOverrides = {}, claimOverrides = {}) => {
  const env = {
    NODE_ENV: "test",
    DATA_PRIMARY_BACKEND: "sanity",
    COMMERCE_PRIMARY_BACKEND: "sanity",
    COMMERCE_FAILOVER_GENERATION: "5",
    COMMERCE_STARTS_PAUSED: "0",
    COMMERCE_DEPLOYMENT_ID: "deployment-five",
    COMMERCE_FAILOVER_LEASE_SECRET: leaseSecret,
    ...envOverrides,
  };
  env.COMMERCE_FAILOVER_LEASE = issueCommerceFailoverLease({
    backend: "sanity",
    generation: 5,
    startsPaused: false,
    deploymentId: "deployment-five",
    secret: leaseSecret,
    issuedAt: nowSeconds - 30,
    expiresAt: nowSeconds + 300,
    ...claimOverrides,
  });
  return env;
};

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

  test("compares a Sanity failover lease to reachable live control", async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          primary_backend: "sanity",
          generation: 5,
          starts_paused: false,
        },
        error: null,
      }),
    };
    await expect(
      assertCommerceStartAllowed({
        env: sanityEnv(),
        client,
        nowSeconds,
      })
    ).resolves.toMatchObject({
      primaryBackend: "sanity",
      generation: 5,
      startsPaused: false,
      deploymentId: "deployment-five",
    });
    expect(client.rpc).toHaveBeenCalledWith("roo_commerce_control");
  });

  test("validates the signed lease locally during a control-plane outage", async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: null,
        error: { code: "PGRST000" },
      }),
    };
    await expect(
      assertCommerceStartAllowed({ env: sanityEnv(), client, nowSeconds })
    ).resolves.toMatchObject({
      primaryBackend: "sanity",
      generation: 5,
      startsPaused: false,
    });
  });

  test("blocks a paused failover without synthesizing an unpaused state", async () => {
    const env = sanityEnv(
      { COMMERCE_STARTS_PAUSED: "1" },
      { startsPaused: true }
    );
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          primary_backend: "sanity",
          generation: 5,
          starts_paused: true,
        },
        error: null,
      }),
    };
    await expect(
      assertCommerceWriteAllowed({
        env,
        client,
        nowSeconds,
      })
    ).rejects.toMatchObject({ code: "COMMERCE_STARTS_PAUSED", status: 503 });
  });

  test.each([
    [
      "live backend mismatch",
      sanityEnv(),
      {
        data: { primary_backend: "supabase", generation: 5, starts_paused: false },
        error: null,
      },
      "COMMERCE_FAILOVER_LEASE_MISMATCH",
    ],
    [
      "deployment mismatch",
      sanityEnv({ COMMERCE_DEPLOYMENT_ID: "different-deployment" }),
      { data: null, error: { code: "PGRST000" } },
      "COMMERCE_FAILOVER_LEASE_MISMATCH",
    ],
    [
      "expired lease",
      sanityEnv({}, { issuedAt: nowSeconds - 600, expiresAt: nowSeconds - 1 }),
      { data: null, error: { code: "PGRST000" } },
      "COMMERCE_FAILOVER_LEASE_INVALID",
    ],
  ])("fails closed for a %s", async (_label, env, rpcResult, code) => {
    const client = { rpc: jest.fn().mockResolvedValue(rpcResult) };
    await expect(
      assertCommerceStartAllowed({ env, client, nowSeconds })
    ).rejects.toMatchObject({ code, status: 503 });
  });

  test("rejects a modified failover signature", async () => {
    const env = sanityEnv();
    const suffix = env.COMMERCE_FAILOVER_LEASE.endsWith("a") ? "b" : "a";
    env.COMMERCE_FAILOVER_LEASE =
      env.COMMERCE_FAILOVER_LEASE.slice(0, -1) + suffix;
    await expect(
      assertCommerceStartAllowed({
        env,
        client: { rpc: jest.fn() },
        nowSeconds,
      })
    ).rejects.toMatchObject({
      code: "COMMERCE_FAILOVER_LEASE_INVALID",
      status: 503,
    });
  });

  test("caps signed failover leases at fifteen minutes", () => {
    expect(() => issueCommerceFailoverLease({
      backend: "sanity",
      generation: 5,
      startsPaused: false,
      deploymentId: "deployment-five",
      secret: leaseSecret,
      issuedAt: nowSeconds,
      expiresAt: nowSeconds + 901,
    })).toThrow("claims are invalid");

    const token = issueCommerceFailoverLease({
      backend: "sanity",
      generation: 5,
      startsPaused: false,
      deploymentId: "deployment-five",
      secret: leaseSecret,
      issuedAt: nowSeconds,
      expiresAt: nowSeconds + 900,
    });
    expect(verifyCommerceFailoverLease({ token, secret: leaseSecret, nowSeconds }))
      .toMatchObject({ generation: 5, deploymentId: "deployment-five" });
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
