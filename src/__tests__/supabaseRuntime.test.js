import {
  CONTENT_ASSIGNMENT_COOKIE,
  selectContentBackend,
  serializeContentAssignmentCookie,
} from "../server/supabase/backendSelection";
import {
  deterministicCanaryBucket,
  resolveSupabaseRuntimePolicy,
  selectCanaryBackend,
  shouldUseSupabaseForAccount,
} from "../server/supabase/runtime";

describe("Supabase runtime selection", () => {
  test("requires an explicit production cutover switch", () => {
    expect(() =>
      resolveSupabaseRuntimePolicy({
        NODE_ENV: "production",
        DATA_PRIMARY_BACKEND: "supabase",
      })
    ).toThrow("SUPABASE_CUTOVER_ENABLED");
  });

  test("defaults data, commerce, content, and auth reads to Supabase", () => {
    expect(resolveSupabaseRuntimePolicy({})).toMatchObject({
      primaryBackend: "supabase",
      commercePrimaryBackend: "supabase",
      commerceFailoverGeneration: 0,
      reverseMirrorEnabled: false,
    });
    expect(selectContentBackend({ env: {} })).toEqual({
      backend: "supabase",
      canaryActive: false,
      assignmentCookie: "",
    });
    expect(shouldUseSupabaseForAccount({ identifier: "person@example.com", env: {} }))
      .toBe(true);
  });

  test("enables mirroring from complete Sanity configuration, not its legacy flag", () => {
    expect(resolveSupabaseRuntimePolicy({})).toMatchObject({
      reverseMirrorEnabled: false,
      reverseMirrorLegacyFlagEnabled: false,
    });
    expect(resolveSupabaseRuntimePolicy({
      SANITY_PROJECT_ID: "project",
      SANITY_DATASET: "production",
      SANITY_WRITE_TOKEN: "write-token",
    })).toMatchObject({
      reverseMirrorEnabled: true,
      reverseMirrorLegacyFlagEnabled: false,
    });
  });

  test("moves commerce without moving CMS, Auth, or Tourney", () => {
    expect(
      resolveSupabaseRuntimePolicy({
        NODE_ENV: "production",
        DATA_PRIMARY_BACKEND: "sanity",
        COMMERCE_PRIMARY_BACKEND: "supabase",
        COMMERCE_CUTOVER_ENABLED: "1",
        SANITY_REVERSE_MIRROR_WRITES: "1",
        COMMERCE_FAILOVER_GENERATION: "4",
        COMMERCE_STARTS_PAUSED: "1",
      })
    ).toMatchObject({
      primaryBackend: "sanity",
      commercePrimaryBackend: "supabase",
      commerceFailoverGeneration: 4,
      commerceStartsPaused: true,
    });
  });

  test("refuses a production commerce cutover without its own gate", () => {
    expect(() =>
      resolveSupabaseRuntimePolicy({
        NODE_ENV: "production",
        DATA_PRIMARY_BACKEND: "sanity",
        COMMERCE_PRIMARY_BACKEND: "supabase",
        SANITY_REVERSE_MIRROR_WRITES: "1",
      })
    ).toThrow("COMMERCE_CUTOVER_ENABLED");
  });

  test("keeps a deterministic canary assignment", () => {
    const key = "visitor-a";
    expect(deterministicCanaryBucket(key)).toBe(deterministicCanaryBucket(key));
    expect(selectCanaryBackend({ key, percentage: 100 })).toBe("supabase");
    expect(selectCanaryBackend({ key, percentage: 0 })).toBe("sanity");
  });

  test("treats a 100 percent content rollout as cacheable Supabase", () => {
    expect(
      selectContentBackend({
        env: {
          DATA_PRIMARY_BACKEND: "sanity",
          SUPABASE_CONTENT_CANARY_PERCENT: "100",
        },
      })
    ).toEqual({
      backend: "supabase",
      canaryActive: false,
      assignmentCookie: "",
    });
  });

  test("reuses a valid assignment cookie and tolerates malformed cookies", () => {
    const value = "2f1a8c2c-6cae-4f67-8e90-12c770c0e719.supabase";
    const selected = selectContentBackend({
      cookieHeader: `${CONTENT_ASSIGNMENT_COOKIE}=${value}; broken=%E0%A4%A`,
      env: { SUPABASE_CONTENT_CANARY_PERCENT: "50" },
    });
    expect(selected).toMatchObject({
      backend: "supabase",
      canaryActive: false,
      assignmentCookie: "",
    });
  });

  test("serializes a secure tab-independent content assignment", () => {
    expect(
      serializeContentAssignmentCookie({ value: "visitor.sanity", secure: true })
    ).toContain("HttpOnly; SameSite=Lax; Secure");
  });
});
