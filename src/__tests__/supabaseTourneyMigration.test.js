import fs from "node:fs";
import path from "node:path";
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

  test("uses guarded deletes when replacing the Supabase Tourney shadow", () => {
    const migrationsDirectory = path.join(process.cwd(), "supabase", "migrations");
    const migrationName = fs
      .readdirSync(migrationsDirectory)
      .find((name) => name.endsWith("_fix_tourney_shadow_safe_delete.sql"));
    expect(migrationName).toBeTruthy();
    const migration = fs.readFileSync(
      path.join(migrationsDirectory, migrationName),
      "utf8"
    );
    const deletes = migration.match(/delete from tourney\.[^;]+;/gi) || [];
    expect(deletes).toHaveLength(12);
    expect(deletes.every((statement) => /\swhere\s/i.test(statement))).toBe(true);
  });
});
