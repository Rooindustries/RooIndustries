import {
  selectTourneyImportAuthUserId,
  verifyTourneyImportResult,
} from "../server/supabase/tourneyMigration";

const snapshot = {
  _counts: { tourney_players: 1 },
  tourney_players: [{ id: "player-1", status: "approved" }],
};

const validImport = {
  target_counts: { tourney_players: 1 },
  source_canonical_hashes: { tourney_players: "source-hash" },
  target_canonical_hashes: { tourney_players: "source-hash" },
  status_counts: { approved: 1 },
  relationships: { orphan_team_members: 0, orphan_player_members: 0 },
};

describe("Tourney migration safety", () => {
  test("uses the mapped Auth user rather than the logical principal id", () => {
    expect(selectTourneyImportAuthUserId({
      authEmail: "player@example.invalid",
      principal: {
        principal_id: "11111111-1111-4111-8111-111111111111",
        auth_user_id: "22222222-2222-4222-8222-222222222222",
      },
    })).toBe("22222222-2222-4222-8222-222222222222");
  });

  test("accepts independently verified counts, hashes, statuses, and relationships", () => {
    expect(verifyTourneyImportResult({ imported: validImport, snapshot })).toEqual({
      relationships: validImport.relationships,
      targetCounts: validImport.target_counts,
      targetHashes: validImport.target_canonical_hashes,
      targetStatusCounts: validImport.status_counts,
    });
  });

  test.each([
    ["count", { target_counts: { tourney_players: 0 } }, /count verification/],
    [
      "hash",
      { target_canonical_hashes: { tourney_players: "different" } },
      /canonical hash verification/,
    ],
    ["status", { status_counts: { pending: 1 } }, /status verification/],
    [
      "orphan",
      { relationships: { orphan_team_members: 1, orphan_player_members: 0 } },
      /relationship verification/,
    ],
  ])("rejects %s drift before Auth work is queued", (_label, override, expected) => {
    expect(() => verifyTourneyImportResult({
      imported: { ...validImport, ...override },
      snapshot,
    })).toThrow(expected);
  });
});
