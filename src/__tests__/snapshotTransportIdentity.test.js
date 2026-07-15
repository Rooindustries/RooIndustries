import { assertConnectedSnapshotIdentity } from "../server/tourney/snapshotTransport";

const connected = (database, username) => async () => [{ database, username }];

const expectMismatch = async ({ actual, expected }) => {
  await expect(assertConnectedSnapshotIdentity({
    sql: connected(actual.database, actual.username),
    expected,
    code: "TOURNEY_SNAPSHOT_IDENTITY_MISMATCH",
  })).rejects.toMatchObject({
    code: "TOURNEY_SNAPSHOT_IDENTITY_MISMATCH",
    status: 503,
  });
};

describe("Tourney snapshot connected database identity", () => {
  const projectRef = "ntezmxzaibrrsgtujgxu";
  const poolerIdentity = {
    database: "postgres",
    hostname: "aws-0-eu-west-1.pooler.supabase.com",
    username: `postgres.${projectRef}`,
    projectRef,
  };

  test("accepts the PostgreSQL role reported by a pinned Supabase pooler target", async () => {
    await expect(assertConnectedSnapshotIdentity({
      sql: connected("postgres", "postgres"),
      expected: poolerIdentity,
      code: "TOURNEY_SNAPSHOT_SUPABASE_IDENTITY_MISMATCH",
    })).resolves.toBeUndefined();
  });

  test("rejects a different pooler role or database", async () => {
    await expectMismatch({
      actual: { database: "postgres", username: "service_role" },
      expected: poolerIdentity,
    });
    await expectMismatch({
      actual: { database: "other", username: "postgres" },
      expected: poolerIdentity,
    });
  });

  test("does not normalize direct Supabase or legacy usernames", async () => {
    const directIdentity = {
      ...poolerIdentity,
      hostname: `db.${projectRef}.supabase.co`,
      username: "postgres",
    };
    await expect(assertConnectedSnapshotIdentity({
      sql: connected("postgres", "postgres"),
      expected: directIdentity,
      code: "TOURNEY_SNAPSHOT_SUPABASE_IDENTITY_MISMATCH",
    })).resolves.toBeUndefined();
    const qualifiedDirectIdentity = {
      ...directIdentity,
      username: `postgres.${projectRef}`,
    };
    await expect(assertConnectedSnapshotIdentity({
      sql: connected("postgres", `postgres.${projectRef}`),
      expected: qualifiedDirectIdentity,
      code: "TOURNEY_SNAPSHOT_SUPABASE_IDENTITY_MISMATCH",
    })).resolves.toBeUndefined();
    await expectMismatch({
      actual: { database: "postgres", username: "postgres" },
      expected: qualifiedDirectIdentity,
    });
    await expect(assertConnectedSnapshotIdentity({
      sql: connected("tourney", "legacy.owner"),
      expected: { database: "tourney", username: "legacy.owner" },
      code: "TOURNEY_SNAPSHOT_LEGACY_IDENTITY_MISMATCH",
    })).resolves.toBeUndefined();
    await expectMismatch({
      actual: { database: "tourney", username: "legacy" },
      expected: { database: "tourney", username: "legacy.owner" },
    });
  });
});
