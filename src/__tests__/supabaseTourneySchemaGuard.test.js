import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "src/server/tourney");

describe("Tourney production schema guard", () => {
  test.each([
    "playerStore.js",
    "bracketStore.js",
    "appealPayoutStore.js",
  ])("asserts the installed schema without production runtime DDL in %s", (file) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const ensureStart = source.indexOf("export async function ensureTourney");
    const migrationCheck = source.indexOf(
      "await assertTourneySchemaVersion(env)",
      ensureStart
    );
    const firstDdl = source.indexOf("create table", ensureStart);
    expect(ensureStart).toBeGreaterThanOrEqual(0);
    expect(migrationCheck).toBeGreaterThan(ensureStart);
    expect(firstDdl).toBe(-1);
    expect(source.toLowerCase()).not.toContain("create table");
    expect(source.toLowerCase()).not.toContain("alter table");
  });
});
