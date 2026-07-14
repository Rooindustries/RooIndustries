import { PassThrough, Readable } from "node:stream";
import {
  expectedConnectedDatabaseUsername,
  loadSupabaseDatabaseTargetFromStdin,
  parseSupabaseDatabaseTargetPayload,
  readSupabaseDatabaseTargetFromStdin,
} from "../../scripts/lib/supabase-database-target-stdin.mjs";

const projectRef = "ntezmxzaibrrsgtujgxu";
const databaseUrl =
  `postgresql://roo_cutover.${projectRef}:temporary-secret@` +
  "aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require";
const fingerprint = "a".repeat(64);
const payload = () => JSON.stringify({
  supabaseDatabaseUrl: databaseUrl,
  expectedFingerprint: fingerprint,
});

describe("in-memory Supabase database target", () => {
  test("accepts only a database URL paired with its pinned fingerprint", () => {
    expect(parseSupabaseDatabaseTargetPayload(payload())).toEqual({
      supabaseDatabaseUrl: databaseUrl,
      expectedFingerprint: fingerprint,
    });
    for (const value of [
      "",
      "[]",
      JSON.stringify({ supabaseDatabaseUrl: databaseUrl }),
      JSON.stringify({
        supabaseDatabaseUrl: databaseUrl,
        expectedFingerprint: fingerprint,
        unexpected: true,
      }),
      JSON.stringify({
        supabaseDatabaseUrl: "https://example.com",
        expectedFingerprint: fingerprint,
      }),
      JSON.stringify({
        supabaseDatabaseUrl: databaseUrl,
        expectedFingerprint: "invalid",
      }),
    ]) {
      expect(() => parseSupabaseDatabaseTargetPayload(value)).toThrow(
        expect.objectContaining({ code: "TOURNEY_SUPABASE_DATABASE_STDIN_INVALID" })
      );
    }
  });

  test("loads the target from standard input without returning or printing it", async () => {
    const env = {
      SUPABASE_DATABASE_URL: "discarded",
      TOURNEY_CUTOVER_EXPECTED_SUPABASE_DATABASE_FINGERPRINT: "discarded",
    };
    const result = await loadSupabaseDatabaseTargetFromStdin({
      env,
      input: Readable.from([payload()]),
    });
    expect(result).toBeUndefined();
    expect(env).toEqual({
      SUPABASE_DATABASE_URL: databaseUrl,
      TOURNEY_CUTOVER_EXPECTED_SUPABASE_DATABASE_FINGERPRINT: fingerprint,
    });
  });

  test("rejects missing and oversized standard input", async () => {
    await expect(readSupabaseDatabaseTargetFromStdin({
      input: Readable.from([]),
    })).rejects.toMatchObject({ code: "TOURNEY_SUPABASE_DATABASE_STDIN_REQUIRED" });
    await expect(readSupabaseDatabaseTargetFromStdin({
      input: Readable.from([payload()]),
      maxBytes: 8,
    })).rejects.toMatchObject({ code: "TOURNEY_SUPABASE_DATABASE_STDIN_TOO_LARGE" });
  });

  test("consumes one line without waiting for the input stream to close", async () => {
    const input = new PassThrough();
    const result = readSupabaseDatabaseTargetFromStdin({ input });
    input.write(`${payload()}\n`);
    await expect(result).resolves.toEqual({
      supabaseDatabaseUrl: databaseUrl,
      expectedFingerprint: fingerprint,
    });
  });

  test("normalizes only the exact project suffix on Supabase pooler usernames", () => {
    const identity = {
      hostname: "aws-0-eu-west-1.pooler.supabase.com",
      username: `roo_cutover.${projectRef}`,
      projectRef,
    };
    expect(expectedConnectedDatabaseUsername(identity)).toBe("roo_cutover");
    expect(expectedConnectedDatabaseUsername({
      ...identity,
      username: "roo_cutover.another-project",
    })).toBe("roo_cutover.another-project");
    expect(expectedConnectedDatabaseUsername({
      ...identity,
      hostname: `db.${projectRef}.supabase.co`,
    })).toBe(`roo_cutover.${projectRef}`);
  });
});
