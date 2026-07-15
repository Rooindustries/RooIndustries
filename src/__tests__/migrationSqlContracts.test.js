import {
  hasBoundedMigrationPrefix,
  hasBrowserDataGrant,
  hasServiceRoleOnlyGrant,
} from "../../scripts/lib/migration-sql-contracts.mjs";

describe("migration SQL release contracts", () => {
  test("requires timeout statements before every other statement", () => {
    expect(hasBoundedMigrationPrefix(
      "set lock_timeout = '5s';\nset statement_timeout = '120s';\nselect 1;"
    )).toBe(true);
    expect(hasBoundedMigrationPrefix(
      "select 1;\nset lock_timeout = '5s';\nset statement_timeout = '120s';\n"
    )).toBe(false);
  });

  test("detects browser roles anywhere in a data grant recipient list", () => {
    expect(hasBrowserDataGrant(
      "grant select on accounts.private_rows to service_role, authenticated;"
    )).toBe(true);
    expect(hasBrowserDataGrant(
      "grant execute on function public.private_rpc() to authenticated;"
    )).toBe(false);
  });

  test("requires one statement-specific service-role-only grant", () => {
    const target = /^grant\s+execute\s+on\s+function\s+public\.private_rpc\s*\(/i;
    expect(hasServiceRoleOnlyGrant(
      "grant execute on function public.private_rpc() to service_role;",
      target
    )).toBe(true);
    expect(hasServiceRoleOnlyGrant(
      "grant execute on function public.private_rpc() to service_role, anon;",
      target
    )).toBe(false);
    expect(hasServiceRoleOnlyGrant(
      "grant execute on function public.private_rpc() to anon;\n" +
        "grant execute on function public.other_rpc() to service_role;",
      target
    )).toBe(false);
  });
});
