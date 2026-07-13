import fs from "node:fs";
import path from "node:path";
import { splitPostgresStatements } from "../server/tourney/sqlStatements";

describe("Tourney legacy SQL splitter", () => {
  test("does not split semicolons inside dollar-quoted functions", () => {
    const statements = splitPostgresStatements(`
      create table example (id text);
      do $$ begin perform 1; perform 2; end; $$;
      insert into example values ('semi;colon');
    `);
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain("perform 1; perform 2;");
  });

  test("parses every statement in the legacy cutover migration", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts", "tourney-cutover-legacy.sql"),
      "utf8"
    );
    const statements = splitPostgresStatements(source);
    expect(statements.length).toBeGreaterThan(15);
    expect(statements.some((statement) => statement.startsWith("do $$"))).toBe(true);
    expect(statements.some((statement) => statement.includes("capture_tourney_mirror_event"))).toBe(true);
  });
});
