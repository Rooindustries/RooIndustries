import { buildTourneySchemaCheckError } from "../server/tourney/sqlClient";

describe("Tourney schema check errors", () => {
  test.each(["3F000", "42P01", "42703", "TOURNEY_SCHEMA_VERSION_TOO_OLD"])(
    "classifies %s as a migration failure",
    (code) => {
      expect(buildTourneySchemaCheckError({
        backend: "supabase",
        cause: { code },
      })).toMatchObject({
        code: "TOURNEY_SCHEMA_MIGRATION_REQUIRED",
        status: 503,
      });
    }
  );

  test.each(["ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "42501"])(
    "classifies %s as database unavailability",
    (code) => {
      expect(buildTourneySchemaCheckError({
        backend: "legacy",
        cause: { code },
      })).toMatchObject({
        code: "TOURNEY_DATABASE_UNAVAILABLE",
        status: 503,
      });
    }
  );
});
