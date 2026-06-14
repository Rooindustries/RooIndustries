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
      secondary_role_play text not null default '',
      approved_role_play text not null default '',
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
      discord_invite_sent_at timestamptz,
      discord_invite_email_id text,
      discord_invite_last_error text,
      discord_user_id text,
      discord_oauth_username text,
      discord_oauth_global_name text,
      discord_linked_at timestamptz,
      discord_role_assigned_at timestamptz,
      discord_role_last_error text,
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
    alter table tourney_players
    add column if not exists accepted_rules boolean not null default false
  `;
  await sql`
    alter table tourney_players
    add column if not exists accepted_roo_visibility boolean not null default false
  `;
  await sql`
    alter table tourney_players
    add column if not exists registration_pool text not null default 'main'
  `;
  await sql`
    alter table tourney_players
    add column if not exists secondary_role_play text not null default ''
  `;
  await sql`
    alter table tourney_players
    add column if not exists approved_role_play text not null default ''
  `;
  await sql`
    alter table tourney_players
    add column if not exists discord_invite_sent_at timestamptz
  `;
  await sql`
    alter table tourney_players
    add column if not exists discord_invite_email_id text
  `;
  await sql`
    alter table tourney_players
    add column if not exists discord_invite_last_error text
  `;
  await sql`
    alter table tourney_players
    add column if not exists discord_user_id text
  `;
  await sql`
    alter table tourney_players
    add column if not exists discord_oauth_username text
  `;
  await sql`
    alter table tourney_players
    add column if not exists discord_oauth_global_name text
  `;
  await sql`
    alter table tourney_players
    add column if not exists discord_linked_at timestamptz
  `;
  await sql`
    alter table tourney_players
    add column if not exists discord_role_assigned_at timestamptz
  `;
  await sql`
    alter table tourney_players
    add column if not exists discord_role_last_error text
  `;
  await sql`
    create unique index if not exists tourney_players_discord_user_id_unique
    on tourney_players (discord_user_id)
    where discord_user_id is not null
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
