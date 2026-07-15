import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const scriptPath = path.join(process.cwd(), "scripts", "tourney-cutover.mjs");
const scriptSource = fs.readFileSync(scriptPath, "utf8");
const moduleUrl = pathToFileURL(scriptPath).href;
const runModule = (body) => JSON.parse(execFileSync(
  process.execPath,
  ["--input-type=module", "--eval", `import * as cutover from ${JSON.stringify(moduleUrl)};${body}`],
  { cwd: process.cwd(), encoding: "utf8" }
));

const safeEnvironment = (overrides = {}) => ({
  TOURNEY_DATABASE_MODE: "supabase",
  TOURNEY_MIRROR_ENABLED: "1",
  TOURNEY_WRITES_PAUSED: "1",
  TOURNEY_FAILOVER_GENERATION: "1",
  TOURNEY_V4_ACTIVATION_ENABLED: "0",
  TOURNEY_HARDENING_V4_ENABLED: "1",
  ...overrides,
});

describe("Tourney snapshot operational input", () => {
  test("allows snapshots while safely paused before or after hardening activation", () => {
    const hardened = safeEnvironment();
    const staged = safeEnvironment({
      TOURNEY_V4_ACTIVATION_ENABLED: "1",
      TOURNEY_HARDENING_V4_ENABLED: "0",
    });
    const result = runModule(`
      const environments=${JSON.stringify([hardened, staged])};
      const accepted=environments.map((env)=>{
        try { cutover.assertSnapshotEnvironment(env); return true; }
        catch { return false; }
      });
      process.stdout.write(JSON.stringify({accepted}));
    `);
    expect(result.accepted).toEqual([true, true]);
  });

  test.each([
    ["writes resumed", { TOURNEY_WRITES_PAUSED: "0" }],
    ["wrong generation", { TOURNEY_FAILOVER_GENERATION: "0" }],
    ["mirror disabled", { TOURNEY_MIRROR_ENABLED: "0" }],
    ["no active phase", {
      TOURNEY_V4_ACTIVATION_ENABLED: "0",
      TOURNEY_HARDENING_V4_ENABLED: "0",
    }],
  ])("rejects %s", (_label, overrides) => {
    const result = runModule(`
      let code='';
      try { cutover.assertSnapshotEnvironment(${JSON.stringify(safeEnvironment(overrides))}); }
      catch (error) { code=error.code; }
      process.stdout.write(JSON.stringify({code}));
    `);
    expect(result.code).toBe("TOURNEY_SNAPSHOT_ENVIRONMENT_MISMATCH");
  });

  test("accepts the stdin target only for snapshot capture", () => {
    expect(scriptSource).toContain("await loadSupabaseDatabaseTargetFromStdin();");
    const result = runModule(`
      process.argv = [
        "node",
        "test",
        "--snapshot",
        "--env",
        "/tmp/private.env",
        "--supabase-database-url-stdin",
      ];
      const accepted=cutover.parseCliAction().flag;
      process.argv = [
        "node",
        "test",
        "--parity",
        "--env",
        "/tmp/private.env",
        "--supabase-database-url-stdin",
      ];
      let rejected='';
      try { cutover.parseCliAction(); }
      catch (error) { rejected=error.code; }
      process.stdout.write(JSON.stringify({accepted,rejected}));
    `);
    expect(result).toEqual({
      accepted: "--snapshot",
      rejected: "TOURNEY_CLI_ARGUMENT_INVALID",
    });
  });
});
