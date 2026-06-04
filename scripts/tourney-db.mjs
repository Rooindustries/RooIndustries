#!/usr/bin/env node
import { neon } from "@neondatabase/serverless";

const databaseUrl = String(
  process.env.TOURNEY_DATABASE_URL || process.env.POSTGRES_URL || ""
).trim();

const printUsage = () => {
  console.error("Usage: TOURNEY_DATABASE_URL='...' node scripts/tourney-db.mjs migrate");
};

const requireSql = () => {
  if (!databaseUrl) {
    throw new Error("TOURNEY_DATABASE_URL is required.");
  }
  return neon(databaseUrl);
};

const migrate = async () => {
  const sql = requireSql();
  await sql`
    create table if not exists tourney_players (
      id text primary key,
      username text not null unique,
      email text not null unique,
      password_hash text not null,
      status text not null default 'pending',
      discord text not null,
      display_name text,
      discord_key text not null unique,
      battlenet text not null,
      rank_name text not null,
      role_play text not null,
      time_zone text not null default '',
      twitch_username text,
      team_name text,
      available_aug_1_2 boolean not null default false,
      notes text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      approved_at timestamptz,
      approved_by text,
      denied_at timestamptz,
      denied_by text,
      removed_at timestamptz,
      removed_by text,
      constraint tourney_players_status_check
        check (status in ('pending', 'approved', 'denied', 'removed'))
    )
  `;
  await sql`
    alter table tourney_players
    add column if not exists display_name text
  `;
  await sql`
    alter table tourney_players
    add column if not exists time_zone text not null default ''
  `;
  await sql`
    alter table tourney_players
    add column if not exists team_name text
  `;
  await sql`
    create table if not exists tourney_player_tokens (
      id text primary key,
      player_id text not null references tourney_players(id) on delete cascade,
      token_hash text not null unique,
      purpose text not null,
      recipient_username text,
      recipient_email text,
      recipient_role text,
      recipient_version text,
      expires_at timestamptz not null,
      used_at timestamptz,
      used_by text,
      created_at timestamptz not null default now(),
      constraint tourney_player_tokens_purpose_check
        check (purpose in ('approve', 'deny', 'reset'))
    )
  `;
  console.log("[tourney-db] migration complete");
};

const main = async () => {
  const command = process.argv[2];
  if (command === "migrate") {
    await migrate();
    return;
  }

  printUsage();
  process.exit(1);
};

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
