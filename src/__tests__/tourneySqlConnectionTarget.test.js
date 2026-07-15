import { buildTourneyPostgresOptions } from "../server/tourney/sqlClient";

const hosted = (parameters = "") =>
  `postgresql://service_role:secret@db.example.com:5432/postgres${parameters}`;

describe("Tourney PostgreSQL connection targets", () => {
  test.each(["", "?sslmode=disable", "?sslmode=prefer"])(
    "rejects a hosted target without enforced TLS: %s",
    (parameters) => {
      expect(() => buildTourneyPostgresOptions({
        backend: "supabase",
        databaseUrl: hosted(parameters),
      })).toThrow("must require TLS");
    }
  );

  test.each([
    "?sslmode=require&search_path=attacker",
    "?sslmode=require&sslmode=require",
    "?sslmode=require#fragment",
  ])("rejects unsafe or ambiguous URL input: %s", (parameters) => {
    expect(() => buildTourneyPostgresOptions({
      backend: "supabase",
      databaseUrl: hosted(parameters),
    })).toThrow();
  });

  test("passes credentials and TLS as explicit driver options", () => {
    const options = buildTourneyPostgresOptions({
      backend: "supabase",
      databaseUrl: hosted("?sslmode=require&target_session_attrs=read-write"),
    });

    expect(options).toMatchObject({
      host: "db.example.com",
      port: 5432,
      database: "postgres",
      user: "service_role",
      password: "secret",
      ssl: "require",
      target_session_attrs: "read-write",
      connection: {
        search_path: "tourney,public",
      },
    });
  });

  test("allows a local test database to disable TLS", () => {
    const options = buildTourneyPostgresOptions({
      backend: "legacy",
      databaseUrl: "postgresql://postgres:secret@127.0.0.1:5432/test?sslmode=disable",
    });

    expect(options.ssl).toBe(false);
    expect(options.connection.search_path).toBe("public");
  });
});
