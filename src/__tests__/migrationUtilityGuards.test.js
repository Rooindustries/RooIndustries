/** @jest-environment node */

import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

describe("migration utility primary-backend guards", () => {
  test.each([
    [
      "commerce sync",
      "scripts/sync-sanity-commerce-to-supabase.mjs",
      "Commerce shadow apply is disabled while Supabase is primary.",
    ],
    [
      "full migration",
      "scripts/migrate-sanity-to-supabase.mjs",
      "Sanity-to-Supabase apply is disabled while Supabase is primary",
    ],
  ])("%s refuses --apply with an empty environment", (_label, script, message) => {
    const result = spawnSync(
      process.execPath,
      [path.resolve(script), "--apply", "--env", "/tmp/roo-missing-runtime-env"],
      {
        cwd: tmpdir(),
        encoding: "utf8",
        env: { PATH: process.env.PATH || "" },
        timeout: 10_000,
      }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain("credentials are required");
  });
});
