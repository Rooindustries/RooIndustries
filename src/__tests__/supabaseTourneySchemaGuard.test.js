import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "src/server/tourney");

describe("dormant Supabase Tourney schema guard", () => {
  test.each([
    "playerStore.js",
    "bracketStore.js",
    "appealPayoutStore.js",
  ])("checks the migrated schema before any runtime DDL in %s", (file) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const ensureStart = source.indexOf("export async function ensureTourney");
    const supabaseGuard = source.indexOf(
      "if (isSupabaseTourneyDatabase(env))",
      ensureStart
    );
    const migrationCheck = source.indexOf(
      "await assertSupabaseTourneySchemaVersion(env)",
      supabaseGuard
    );
    const firstDdl = source.indexOf("create table", ensureStart);
    expect(ensureStart).toBeGreaterThanOrEqual(0);
    expect(supabaseGuard).toBeGreaterThan(ensureStart);
    expect(migrationCheck).toBeGreaterThan(supabaseGuard);
    expect(firstDdl).toBeGreaterThan(migrationCheck);
  });
});
