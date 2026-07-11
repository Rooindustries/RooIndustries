import { createShadowingSanityClient } from "../server/supabase/shadowingSanityClient";

const createShadowClient = () => ({
  rpc: jest.fn(async (name) => {
    if (name === "roo_tombstone_shadow_ids") {
      return { data: { tombstoned: 1 }, error: null };
    }
    if (name === "roo_import_shadow_batch") {
      return { data: { imported: 1, skipped_stale: 0 }, error: null };
    }
    if (name === "roo_project_referral_account_shadow") {
      return { data: { updated: 1 }, error: null };
    }
    if (name === "roo_refresh_operational_shadow") {
      return { data: { projection: {}, cleanup: {} }, error: null };
    }
    if (name === "roo_resolve_mirror_failure") {
      return { data: { resolved: false }, error: null };
    }
    return { data: null, error: { code: "UNKNOWN_RPC" } };
  }),
});

describe("Sanity to Supabase live shadow mirroring", () => {
  test("records Sanity deletes as tombstones", async () => {
    const sanityClient = {
      delete: jest.fn().mockResolvedValue({ deleted: true }),
      fetch: jest.fn().mockResolvedValue([]),
    };
    const shadowClient = createShadowClient();
    const client = createShadowingSanityClient({ sanityClient, shadowClient });

    await expect(client.delete("rateLimitBucket.one")).resolves.toEqual({
      deleted: true,
    });
    expect(shadowClient.rpc).toHaveBeenCalledWith(
      "roo_tombstone_shadow_ids",
      expect.objectContaining({
        p_ids: ["rateLimitBucket.one"],
        p_deleted_at: expect.any(String),
      })
    );
    expect(shadowClient.rpc).not.toHaveBeenCalledWith(
      "roo_apply_document_mutations",
      expect.anything()
    );
  });

  test("refreshes referral projections after a mirrored write", async () => {
    const referral = {
      _id: "referral.one",
      _type: "referral",
      _rev: "new",
      _updatedAt: "2026-07-11T01:00:00.000Z",
      creatorEmail: "creator@example.invalid",
      slug: { current: "creator" },
    };
    const sanityClient = {
      create: jest.fn().mockResolvedValue(referral),
      fetch: jest.fn().mockResolvedValue([referral]),
    };
    const shadowClient = createShadowClient();
    const client = createShadowingSanityClient({ sanityClient, shadowClient });

    await expect(client.create(referral)).resolves.toEqual(referral);
    expect(shadowClient.rpc).toHaveBeenCalledWith(
      "roo_project_referral_account_shadow",
      { p_legacy_sanity_ids: ["referral.one"] }
    );
  });
});
