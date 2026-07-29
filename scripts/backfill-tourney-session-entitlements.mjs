#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import dotenv from "dotenv";
import postgres from "postgres";
import { buildPostgresConnectionOptions } from "./lib/postgres-connection-env.mjs";

const args = new Set(process.argv.slice(2));
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
};
const apply = args.has("--apply");
const explicitEnv = valueAfter("--env");

for (const candidate of [explicitEnv, ".env.local"]) {
  if (candidate && fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false, quiet: true });
  }
}

if (apply && !explicitEnv) {
  throw new Error("--apply requires an explicit --env file.");
}

const databaseUrl = String(process.env.SUPABASE_DATABASE_URL || "").trim();
if (!databaseUrl) {
  throw new Error("SUPABASE_DATABASE_URL is required.");
}

const sql = postgres({
  ...buildPostgresConnectionOptions(databaseUrl),
  max: 1,
  prepare: false,
  connection: {
    application_name: "roo-tourney-session-entitlement-backfill",
    search_path: "tourney,public",
  },
});

try {
  const [summary] = await sql`
    select
      count(*) filter (where player.status = 'approved')::integer as approved_players,
      count(entitlement.id)::integer as existing_entitlements,
      count(*) filter (
        where player.status = 'approved' and entitlement.id is null
      )::integer as entitlements_to_create
    from tourney.tourney_players player
    left join tourney.tourney_session_entitlements entitlement
      on entitlement.player_id = player.id
    where player.status = 'approved'
  `;

  let inserted = 0;
  if (apply) {
    const rows = await sql`
      insert into tourney.tourney_session_entitlements (
        player_id, status, updated_by
      )
      select player.id, 'available', 'backfill:tourney-free-session-entitlements'
      from tourney.tourney_players player
      where player.status = 'approved'
      on conflict (player_id) do nothing
      returning id
    `;
    inserted = rows.length;
  }

  process.stdout.write(`${JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    approvedPlayers: Number(summary?.approved_players || 0),
    existingEntitlements: Number(summary?.existing_entitlements || 0),
    entitlementsToCreate: Number(summary?.entitlements_to_create || 0),
    inserted,
  }, null, 2)}\n`);
} finally {
  await sql.end({ timeout: 5 });
}
