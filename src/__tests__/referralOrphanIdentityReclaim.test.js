import fs from "node:fs";
import path from "node:path";

import {
  createReferralOrphanReclaimCookie,
  matchesReferralOrphanReclaim,
  readReferralOrphanReclaim,
  reclaimReferralOrphanIdentity,
} from "../server/supabase/orphanIdentityReclaim";

const migrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260717231518_harden_referral_social_orphan_reclaim.sql"
);

const cookieRequest = (cookie) => ({
  cookies: {
    get: (name) =>
      name === cookie.name ? { value: cookie.value } : undefined,
  },
  headers: { get: () => "" },
});

describe("referral orphan identity reclaim", () => {
  test("accepts only an unexpired signed recovery bound to the active creator", () => {
    const now = Date.parse("2026-07-18T00:00:00.000Z");
    const recovery = {
      originalIntentId: "11111111-1111-4111-8111-111111111111",
      principalId: "22222222-2222-4222-8222-222222222222",
      provider: "discord",
      targetUserId: "33333333-3333-4333-8333-333333333333",
    };
    const cookie = createReferralOrphanReclaimCookie({
      env: { REF_SESSION_SECRET: "test-secret" },
      now,
      ...recovery,
    });
    const parsed = readReferralOrphanReclaim({
      env: { REF_SESSION_SECRET: "test-secret" },
      now: now + 1_000,
      request: cookieRequest(cookie),
    });

    expect(parsed).toMatchObject(recovery);
    expect(
      matchesReferralOrphanReclaim({
        account: {
          creator_active: true,
          principal_id: recovery.principalId,
          roles: ["creator"],
          status: "active",
        },
        recovery: parsed,
        user: { id: recovery.targetUserId },
      })
    ).toBe(true);
    expect(
      readReferralOrphanReclaim({
        env: { REF_SESSION_SECRET: "test-secret" },
        now: now + 16 * 60 * 1_000,
        request: cookieRequest(cookie),
      })
    ).toBeNull();
  });

  test("passes only the proven owner and opaque intent token to the guarded RPC", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: { reclaimed: true, reason: "orphan_reclaimed" },
      error: null,
    });

    const result = await reclaimReferralOrphanIdentity({
      adminClient: { rpc },
      orphanUserId: "394cef15-efb8-4ad3-bce5-280e91f01dbf",
      provider: "discord",
      token: "opaque-intent-token",
    });

    expect(result).toMatchObject({ reclaimed: true });
    expect(rpc).toHaveBeenCalledWith("roo_reclaim_referral_orphan_identity", {
      p_orphan_user_id: "394cef15-efb8-4ad3-bce5-280e91f01dbf",
      p_provider: "discord",
      p_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("locks out active creator and active Tourney owners before the identity move", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    const activeCreatorGuard = sql.indexOf("creator.active");
    const activeTourneyGuard = sql.indexOf("tourney_account.active");
    const providerOnlyGuard = sql.indexOf("v_owner_identity_count <> 1");
    const move = sql.indexOf("update auth.identities identity");

    expect(activeCreatorGuard).toBeGreaterThan(-1);
    expect(activeTourneyGuard).toBeGreaterThan(-1);
    expect(providerOnlyGuard).toBeGreaterThan(-1);
    expect(activeCreatorGuard).toBeLessThan(move);
    expect(activeTourneyGuard).toBeLessThan(move);
    expect(providerOnlyGuard).toBeLessThan(move);
    expect(sql).toContain("v_block_outcome := 'blocked_active_account'");
    expect(sql).toContain("v_source_mapping_count <> 1");
    expect(sql).toContain("identity.user_id = p_orphan_user_id");
    expect(sql).toContain("and identity.provider_id = v_provider_subject");
    expect(sql).not.toContain("roo_merge_account_principals");
  });

  test("allows a provider-only transient owner with no active Tourney account", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(
      /where tourney_account\.principal_id = v_source_principal_id\s+and tourney_account\.active/
    );
    expect(sql).not.toContain("tourney_account.active is false");
  });
});
