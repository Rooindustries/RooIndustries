import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const scriptPath = path.join(process.cwd(), "scripts", "tourney-live-drift-repair.mjs");
const scriptSource = fs.readFileSync(scriptPath, "utf8");

const moduleUrl = pathToFileURL(scriptPath).href;
const runModule = (body) => JSON.parse(execFileSync(
  process.execPath,
  ["--input-type=module", "--eval", `import * as repair from ${JSON.stringify(moduleUrl)};${body}`],
  { cwd: process.cwd(), encoding: "utf8" }
));

const reviewedSummary = () => ({
  tokens: {
    source_count: 633,
    target_count: 633,
    different_rows: 3,
    missing_source: 0,
    missing_target: 0,
    recipient_version_only: 3,
    other_field_drift: 0,
    diff_set_hash: "c75829f0006667a810595cc02628e26f02c10ebdfa4abc936cce351f2784c29b",
    diffs: Array.from({ length: 3 }, (_, index) => ({
      id: `fixture-token-${index}`,
      id_hash: String(index).repeat(64),
      source_recipient_version: "3",
      target_recipient_version: null,
      other_fields_equal: true,
    })),
  },
  discord: {
    source_count: 25,
    target_count: 24,
    exact_principal_rows: 0,
    different_principal_rows: 24,
    source_only: 1,
    target_only: 0,
    diff_set_hash: "9bbd5b095591c66d96d25b574407490a670c1eb8cd0b24b65ec6068241d27b49",
  },
  collision: {
    count: 1,
    source_hash: "4fcaa4fd216a92bbc07d5bb1ff66d347554aad44d74d33e04e70972cb53be56b",
    player_hash: "9dff440484cf80e8d492437d90d02794f92c9d261dc1f656861bcd1f6ea766c1",
    discord_hash: "f7fcaa07d097e841c7c15e3efeea702ec189e69f7efc0a7e005919259753517b",
    linked_principal_hash: "905d056a89020d182720b56dc08cc74b87c15011c88cc26da4397cbeedee235c",
    canonical_principal_hash: "941942717235b4b5f0422aa5378aaeff3c5ae7ebf46e85a67e76d0a6498edd21",
    authority: { canonical: true },
  },
});

describe("deterministic Tourney live-drift repair", () => {
  test("pins the reviewed production counts, hashes, and event envelope", () => {
    const result = runModule(`
      const summary=${JSON.stringify(reviewedSummary())};
      repair.assertLiveDriftSummary(summary);
      process.stdout.write(JSON.stringify({
        events:repair.EXPECTED_LIVE_DRIFT.events,
        authorizationHash:repair.buildLiveDriftAuthorizationHash(),
        conflictId:repair.buildLiveDriftConflictId(repair.EXPECTED_LIVE_DRIFT.collision.sourceHash)
      }));
    `);
    expect(result.events).toEqual({
      tourney_player_tokens: 3,
      discord_role_assignments: 25,
      tourney_players: 1,
      total: 29,
    });
    expect(result.authorizationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.conflictId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  test.each([
    ["token count", (summary) => { summary.tokens.different_rows = 4; }],
    ["token field", (summary) => { summary.tokens.diffs[0].target_recipient_version = "2"; }],
    ["Discord hash", (summary) => { summary.discord.diff_set_hash = "0".repeat(64); }],
    ["collision count", (summary) => { summary.collision.count = 2; }],
    ["canonical authority", (summary) => { summary.collision.authority.canonical = false; }],
  ])("rejects changed %s", (_label, mutate) => {
    const summary = reviewedSummary();
    mutate(summary);
    const result = runModule(`
      let rejected=false;
      try { repair.assertLiveDriftSummary(${JSON.stringify(summary)}); }
      catch { rejected=true; }
      process.stdout.write(JSON.stringify({rejected}));
    `);
    expect(result.rejected).toBe(true);
  });

  test("keeps the command fail-closed and free of side-effect calls", () => {
    expect(scriptSource).toContain("TOURNEY_WRITES_PAUSED");
    expect(scriptSource).toContain("tourney.capture_mirror_event_v4()'::regprocedure");
    expect(scriptSource).toContain("set_config('roo.tourney_mirror_apply','0',true)");
    expect(scriptSource).toContain("status='blocked_reauth'");
    expect(scriptSource).toContain("discord_user_id=null");
    expect(scriptSource).toContain("canonicalDiscordPrincipalId");
    expect(scriptSource).not.toMatch(/\bfetch\s*\(/);
    expect(scriptSource).not.toMatch(/discord(?:app)?\.com\/api/i);
    expect(scriptSource).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(scriptSource).not.toMatch(/update\s+tourney_(?:players|player_tokens|discord_role_assignments)/i);
  });

  test("casts UUID identifiers before applying PostgreSQL aggregates", () => {
    expect(scriptSource).toContain("min(linked_principal_id::text) linked_principal_id");
    expect(scriptSource).toContain("min(canonical_principal_id::text) canonical_principal_id");
    expect(scriptSource).toContain("min(identity_link_id::text) identity_link_id");
    expect(scriptSource).not.toMatch(/min\((?:linked_principal_id|canonical_principal_id|identity_link_id)\)::text/);
  });

  test("does not serialize the concurrent inspection queries onto one connection", () => {
    expect(scriptSource).toContain("const LIVE_DRIFT_CONNECTION_LIMIT = 7;");
    expect(scriptSource).toContain("max: LIVE_DRIFT_CONNECTION_LIMIT");
  });

  test("fences apply against the validated full logical snapshot", () => {
    expect(scriptSource).toContain(
      "validateFullLogicalSnapshot(snapshot?.supabase?.payload, { hash: sha256 })"
    );
    expect(scriptSource).toContain(
      'readFullLogicalSnapshotRows(snapshot, "accounts.identity_links")'
    );
    expect(scriptSource).not.toContain(
      'snapshot.supabase?.payload?.["accounts.identity_links"]'
    );
  });

  test("allows apply to resume after the deterministic fallback audit was committed", () => {
    expect(scriptSource).toContain("allowConflictId: expectedConflictId");
    expect(scriptSource).toContain("assertLiveDriftLegacyDatabaseGate(legacy, { allowConflictId })");
    expect(scriptSource).not.toContain("assertLiveDriftLegacyDatabaseGate(legacy);\n  const legacyRows");
  });

  test("rejects duplicate action and value flags", () => {
    const result = runModule(`
      const cases=[
        ['--preflight','--preflight','--env','/tmp/private-env'],
        ['--preflight','--env','/tmp/private-env','--env','/tmp/other-env'],
        ['--apply','--env','/tmp/private-env','--authorization-hash','a','--authorization-hash','b']
      ];
      const codes=cases.map((args)=>{
        try { repair.parseLiveDriftArguments(args); return ''; }
        catch (error) { return error.code; }
      });
      process.stdout.write(JSON.stringify({codes}));
    `);
    expect(result.codes).toEqual([
      "LIVE_DRIFT_ARGUMENT_DUPLICATE",
      "LIVE_DRIFT_ARGUMENT_DUPLICATE",
      "LIVE_DRIFT_ARGUMENT_DUPLICATE",
    ]);
  });

  test("accepts one in-memory Supabase target flag for every repair phase", () => {
    expect(scriptSource).toContain("await loadSupabaseDatabaseTargetFromStdin();");
    const result = runModule(`
      const parsed=['--preflight','--apply','--finalize'].map((action)=>{
        const args=[action,'--env','/tmp/private-env','--supabase-database-url-stdin'];
        if (action!=='--preflight') args.push('--authorization-hash','a');
        if (action==='--apply') args.push('--verified-snapshot','/tmp/snapshot.enc');
        return repair.parseLiveDriftArguments(args).useSupabaseDatabaseUrlStdin;
      });
      let duplicate='';
      try {
        repair.parseLiveDriftArguments([
          '--preflight','--env','/tmp/private-env',
          '--supabase-database-url-stdin','--supabase-database-url-stdin'
        ]);
      } catch (error) { duplicate=error.code; }
      process.stdout.write(JSON.stringify({parsed,duplicate}));
    `);
    expect(result).toEqual({
      parsed: [true, true, true],
      duplicate: "LIVE_DRIFT_ARGUMENT_DUPLICATE",
    });
  });

  test("matches a pooler session current_user without weakening the pinned identity", () => {
    const result = runModule(`
      const projectRef='ntezmxzaibrrsgtujgxu';
      const identity={
        database:'postgres',
        hostname:'aws-0-eu-west-1.pooler.supabase.com',
        username:'roo_cutover.'+projectRef,
        projectRef
      };
      const accepted=await repair.assertConnectedDatabaseIdentity(
        async()=>[{database:'postgres',username:'roo_cutover'}],
        identity,
        'LIVE_DRIFT_SOURCE_CONNECTION_IDENTITY_INVALID'
      );
      let rejected='';
      try {
        await repair.assertConnectedDatabaseIdentity(
          async()=>[{database:'postgres',username:'roo_cutover_other'}],
          identity,
          'LIVE_DRIFT_SOURCE_CONNECTION_IDENTITY_INVALID'
        );
      } catch (error) { rejected=error.code; }
      process.stdout.write(JSON.stringify({accepted,rejected,identity}));
    `);
    expect(result.accepted).toEqual({ database: "postgres", username: "roo_cutover" });
    expect(result.rejected).toBe("LIVE_DRIFT_SOURCE_CONNECTION_IDENTITY_INVALID");
    expect(result.identity.username).toBe(
      "roo_cutover.ntezmxzaibrrsgtujgxu"
    );
  });

  test("accepts only real regular snapshot files inside the approved root", () => {
    const result = runModule(`
      const fs=(await import('node:fs')).default;
      const os=(await import('node:os')).default;
      const path=(await import('node:path')).default;
      const home=fs.mkdtempSync(path.join(os.tmpdir(),'live-drift-snapshot-'));
      const root=path.join(home,'Documents','Codex','Tourney Cutover');
      fs.mkdirSync(root,{recursive:true});
      const approved=path.join(root,'verified.snapshot.enc');
      const outside=path.join(home,'outside.snapshot.enc');
      const linked=path.join(root,'linked.snapshot.enc');
      fs.writeFileSync(approved,'approved');
      fs.writeFileSync(outside,'outside');
      fs.symlinkSync(outside,linked);
      const valid=repair.resolveApprovedSnapshotPath(approved,{homeDirectory:home})===fs.realpathSync(approved);
      const rejected=[];
      for (const candidate of [outside,linked]) {
        try { repair.resolveApprovedSnapshotPath(candidate,{homeDirectory:home}); rejected.push(false); }
        catch { rejected.push(true); }
      }
      fs.rmSync(home,{recursive:true,force:true});
      process.stdout.write(JSON.stringify({valid,rejected}));
    `);
    expect(result).toEqual({ valid: true, rejected: [true, true] });
  });
});
