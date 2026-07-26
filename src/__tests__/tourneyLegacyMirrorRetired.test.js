import fs from "node:fs";
import path from "node:path";

// The legacy Neon project exhausted its 5 GB monthly transfer allowance because
// parity opened a connection to it on every reconciliation run -- roughly 286 runs
// a day, each full-scanning a 4.4 MB working set on both backends, about 37 GB a
// month spent verifying data that no user-facing route reads. These tests pin the
// retirement so a later change cannot quietly reconnect to it.

const readSource = (relative) =>
  fs.readFileSync(path.resolve(relative), "utf8");

describe("parity skips the legacy backend once the mirror is retired", () => {
  const store = readSource("src/server/tourney/store.js");

  test("bails out before opening the target connection", () => {
    const parityStart = store.indexOf("export const runTourneyParity");
    expect(parityStart).toBeGreaterThan(-1);
    const body = store.slice(parityStart, parityStart + 2500);
    const guard = body.indexOf("if (!policy.mirrorEnabled)");
    const targetConnection = body.indexOf('getTourneySqlForBackend({ backend: targetBackend');
    expect(guard).toBeGreaterThan(-1);
    expect(targetConnection).toBeGreaterThan(-1);
    // Ordering is the whole point: a guard placed after the connection would
    // still spend the egress it is meant to save.
    expect(guard).toBeLessThan(targetConnection);
  });

  test("reports why it skipped rather than reporting success", () => {
    const parityStart = store.indexOf("export const runTourneyParity");
    const body = store.slice(parityStart, parityStart + 2500);
    expect(body).toContain('reason: "mirror_disabled"');
    expect(body).toContain("skipped: true");
  });

  test("mirror delivery already returns early when disabled", () => {
    expect(store).toContain(
      "if (!policy.mirrorEnabled) return { enabled: false, applied: 0, failed: 0 };"
    );
  });
});

describe("runtime env validation after retirement", () => {
  const validator = readSource("scripts/validate-runtime-env.js");

  test("no longer demands the mirror while Supabase is primary", () => {
    expect(validator).not.toContain(
      "Supabase Tourney primary requires TOURNEY_MIRROR_ENABLED=1"
    );
  });

  test("still refuses a mirror with nowhere to deliver", () => {
    expect(validator).toContain(
      "TOURNEY_MIRROR_ENABLED=1 requires a legacy Tourney database URL to mirror into."
    );
  });
});

describe("retirement migrations", () => {
  const triggers = readSource(
    "supabase/migrations/20260726160000_retire_legacy_mirror_triggers.sql"
  );
  const contracts = readSource(
    "supabase/migrations/20260726160500_retire_legacy_mirror_contracts.sql"
  );

  test("detaches the capture triggers and verifies none remain", () => {
    expect(triggers).toContain("drop trigger if exists capture_tourney_mirror_event");
    expect(triggers).toContain("raise exception 'Mirror capture triggers remain attached");
  });

  test("disables contracts rather than deleting them", () => {
    expect(contracts).toContain("set enabled = false");
    expect(contracts).not.toMatch(/delete\s+from\s+tourney\.mirror_contracts/i);
    expect(contracts).toContain("raise exception 'Mirror contracts remain enabled");
  });

  test("orders the contract migration after the trigger migration", () => {
    // capture_mirror_event_v4 raises when a table has no enabled contract, so
    // disabling contracts first would abort every tourney write.
    expect(Number("20260726160000")).toBeLessThan(Number("20260726160500"));
    expect(contracts).toContain("Requires 20260726160000");
  });

  test("leaves the outbox history intact", () => {
    for (const migration of [triggers, contracts]) {
      expect(migration).not.toMatch(/drop\s+table/i);
      expect(migration).not.toMatch(/truncate/i);
      expect(migration).not.toMatch(/delete\s+from\s+tourney\.mirror_outbox/i);
    }
  });
});
