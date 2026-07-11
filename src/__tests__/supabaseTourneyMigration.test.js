import { readOptionalTourneyTable } from "../server/supabase/tourneyMigration";

describe("Supabase Tourney migration safeguards", () => {
  test("represents a missing optional legacy table as an empty source", async () => {
    const result = await readOptionalTourneyTable({
      table: "tourney_appeals",
      load: async () => {
        throw Object.assign(new Error("relation does not exist"), {
          code: "42P01",
        });
      },
    });

    expect(result).toEqual({
      table: "tourney_appeals",
      rows: [],
      missing: true,
    });
  });

  test("does not hide real source database failures", async () => {
    await expect(
      readOptionalTourneyTable({
        table: "tourney_players",
        load: async () => {
          throw Object.assign(new Error("connection failed"), {
            code: "08006",
          });
        },
      })
    ).rejects.toThrow("connection failed");
  });
});
