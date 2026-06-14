import crypto from "crypto";
import { listManageTourneyPlayers } from "./playerStore";

export const TOURNEY_APPEAL_TYPES = Object.freeze([
  "team-appeal",
  "captain-complaint",
]);
export const TOURNEY_APPEAL_STATUSES = Object.freeze([
  "open",
  "reviewing",
  "upheld",
  "denied",
  "closed",
]);
export const TOURNEY_PAYOUT_TYPES = Object.freeze([
  "placement",
  "mvp",
  "proceeds",
  "adjustment",
]);
export const TOURNEY_PAYOUT_STATUSES = Object.freeze([
  "pending",
  "ready",
  "paid",
  "void",
]);

const MEMORY_STORE =
  globalThis.__rooTourneyAppealPayoutStore ||
  (globalThis.__rooTourneyAppealPayoutStore = {
    appeals: [],
    payouts: [],
  });
const SQL_CLIENTS =
  globalThis.__rooTourneyAppealPayoutSqlClients ||
  (globalThis.__rooTourneyAppealPayoutSqlClients = new Map());
let schemaReady = false;

const nowIso = () => new Date().toISOString();
const normalizeText = (value) => String(value || "").trim();
const normalizeKey = (value) => normalizeText(value).toLowerCase();
const isAdminSession = (session = null) =>
  session?.role === "owner" || session?.role === "caster";
const isPlayerSession = (session = null) => session?.role === "player";

const isMemoryMode = (env = process.env) =>
  env.TOURNEY_APPEAL_PAYOUT_STORE_MODE === "memory" ||
  env.TOURNEY_DATABASE_MODE === "memory";

const getDatabaseUrl = (env = process.env) =>
  normalizeText(env.TOURNEY_DATABASE_URL || env.POSTGRES_URL);

const getSql = async (env = process.env) => {
  const databaseUrl = getDatabaseUrl(env);
  if (!databaseUrl) {
    throw new Error("TOURNEY_DATABASE_URL is not configured.");
  }
  if (!SQL_CLIENTS.has(databaseUrl)) {
    const { neon } = await import("@neondatabase/serverless");
    SQL_CLIENTS.set(databaseUrl, neon(databaseUrl));
  }
  return SQL_CLIENTS.get(databaseUrl);
};

export const resetMemoryTourneyAppealPayoutStoreForTests = () => {
  MEMORY_STORE.appeals = [];
  MEMORY_STORE.payouts = [];
};

export async function ensureTourneyAppealPayoutSchema(env = process.env) {
  if (isMemoryMode(env) || schemaReady) return;
  const sql = await getSql(env);
  await sql`
    create table if not exists tourney_appeals (
      id text primary key,
      type text not null,
      status text not null default 'open',
      team_name text,
      captain_name text,
      submitter_player_id text,
      submitter_username text not null,
      subject_player_id text,
      subject_name text,
      title text not null,
      details text not null,
      evidence_url text,
      ruling text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      updated_by text
    )
  `;
  await sql`
    create table if not exists tourney_payouts (
      id text primary key,
      player_id text not null,
      display_name text not null,
      team_name text,
      payout_type text not null,
      amount_usd numeric(10,2) not null default 0,
      status text not null default 'pending',
      payout_email text,
      notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      updated_by text
    )
  `;
  schemaReady = true;
}

const assertAuthed = (session) => {
  if (!session || (!isAdminSession(session) && !isPlayerSession(session))) {
    throw Object.assign(new Error("Not found."), { status: 404 });
  }
};

const assertAdmin = (session) => {
  if (!isAdminSession(session)) {
    throw Object.assign(new Error("Not found."), { status: 404 });
  }
};

const normalizeChoice = (value, choices, fallback = "") => {
  const normalized = normalizeKey(value);
  return choices.includes(normalized) ? normalized : fallback;
};

const validateAppealPayload = (payload = {}) => {
  const type = normalizeChoice(payload.type, TOURNEY_APPEAL_TYPES);
  const title = normalizeText(payload.title).replace(/\s+/g, " ");
  const details = normalizeText(payload.details);
  const status = normalizeChoice(
    payload.status,
    TOURNEY_APPEAL_STATUSES,
    "open"
  );
  const errors = [];
  if (!type) errors.push("Choose an appeal type.");
  if (title.length < 3) errors.push("Appeal title is required.");
  if (details.length < 3) errors.push("Appeal details are required.");
  return {
    ok: errors.length === 0,
    errors,
    value: {
      type,
      status,
      title,
      details,
      teamName: normalizeText(payload.teamName).replace(/\s+/g, " "),
      captainName: normalizeText(payload.captainName).replace(/\s+/g, " "),
      subjectPlayerId: normalizeText(payload.subjectPlayerId),
      subjectName: normalizeText(payload.subjectName).replace(/\s+/g, " "),
      evidenceUrl: normalizeText(payload.evidenceUrl),
      ruling: normalizeText(payload.ruling),
    },
  };
};

const validatePayoutPayload = async ({ payload = {}, env = process.env }) => {
  const playerId = normalizeText(payload.playerId);
  const payoutType = normalizeChoice(payload.payoutType, TOURNEY_PAYOUT_TYPES);
  const status = normalizeChoice(
    payload.status,
    TOURNEY_PAYOUT_STATUSES,
    "pending"
  );
  const amountUsd = Number(payload.amountUsd || 0);
  const errors = [];
  if (!playerId) errors.push("Choose a player.");
  if (!payoutType) errors.push("Choose a payout type.");
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    errors.push("Amount must be zero or higher.");
  }

  const player = playerId
    ? (await listManageTourneyPlayers({ env })).find((entry) => entry.id === playerId)
    : null;
  if (playerId && !player) errors.push("Player not found.");

  return {
    ok: errors.length === 0,
    errors,
    value: {
      payoutId: normalizeText(payload.payoutId),
      playerId,
      displayName: player?.displayName || player?.discord || "Player",
      teamName: normalizeText(payload.teamName || player?.teamName).replace(/\s+/g, " "),
      payoutType,
      amountUsd,
      status,
      payoutEmail: normalizeText(payload.payoutEmail),
      notes: normalizeText(payload.notes),
    },
  };
};

const mapAppeal = (row = {}) => ({
  id: row.id,
  type: row.type,
  status: row.status || "open",
  teamName: row.team_name || row.teamName || "",
  captainName: row.captain_name || row.captainName || "",
  submitterPlayerId: row.submitter_player_id || row.submitterPlayerId || "",
  submitterUsername: row.submitter_username || row.submitterUsername || "",
  subjectPlayerId: row.subject_player_id || row.subjectPlayerId || "",
  subjectName: row.subject_name || row.subjectName || "",
  title: row.title || "",
  details: row.details || "",
  evidenceUrl: row.evidence_url || row.evidenceUrl || "",
  ruling: row.ruling || "",
  createdAt: row.created_at || row.createdAt || "",
  updatedAt: row.updated_at || row.updatedAt || "",
  updatedBy: row.updated_by || row.updatedBy || "",
});

const mapPayout = (row = {}) => ({
  id: row.id,
  playerId: row.player_id || row.playerId || "",
  displayName: row.display_name || row.displayName || "Player",
  teamName: row.team_name || row.teamName || "",
  payoutType: row.payout_type || row.payoutType || "",
  amountUsd: Number(row.amount_usd ?? row.amountUsd ?? 0),
  status: row.status || "pending",
  payoutEmail: row.payout_email || row.payoutEmail || "",
  notes: row.notes || "",
  createdAt: row.created_at || row.createdAt || "",
  updatedAt: row.updated_at || row.updatedAt || "",
  updatedBy: row.updated_by || row.updatedBy || "",
});

export async function createTourneyAppeal({
  payload,
  session,
  env = process.env,
} = {}) {
  assertAuthed(session);
  const validation = validateAppealPayload(payload);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.errors[0] || "Invalid appeal."), {
      status: 400,
      errors: validation.errors,
    });
  }

  const value = validation.value;
  const now = nowIso();
  const row = {
    id: crypto.randomUUID(),
    type: value.type,
    status: "open",
    team_name: value.teamName,
    captain_name: value.captainName,
    submitter_player_id: session.playerId || "",
    submitter_username: session.username,
    subject_player_id: value.subjectPlayerId,
    subject_name: value.subjectName,
    title: value.title,
    details: value.details,
    evidence_url: value.evidenceUrl,
    ruling: "",
    created_at: now,
    updated_at: now,
    updated_by: session.username,
  };

  if (isMemoryMode(env)) {
    MEMORY_STORE.appeals.push(row);
    return mapAppeal(row);
  }

  await ensureTourneyAppealPayoutSchema(env);
  const sql = await getSql(env);
  await sql`
    insert into tourney_appeals (
      id, type, status, team_name, captain_name, submitter_player_id,
      submitter_username, subject_player_id, subject_name, title, details,
      evidence_url, ruling, created_at, updated_at, updated_by
    )
    values (
      ${row.id}, ${row.type}, ${row.status}, ${row.team_name}, ${row.captain_name},
      ${row.submitter_player_id || null}, ${row.submitter_username},
      ${row.subject_player_id || null}, ${row.subject_name}, ${row.title},
      ${row.details}, ${row.evidence_url}, ${row.ruling}, ${row.created_at},
      ${row.updated_at}, ${row.updated_by}
    )
  `;
  return mapAppeal(row);
}

export async function updateTourneyAppeal({
  appealId,
  payload,
  session,
  env = process.env,
} = {}) {
  assertAdmin(session);
  const status = normalizeChoice(payload?.status, TOURNEY_APPEAL_STATUSES);
  if (!status) {
    throw Object.assign(new Error("Choose an appeal status."), { status: 400 });
  }
  const ruling = normalizeText(payload?.ruling);
  const now = nowIso();

  if (isMemoryMode(env)) {
    const row = MEMORY_STORE.appeals.find((appeal) => appeal.id === appealId);
    if (!row) throw Object.assign(new Error("Appeal not found."), { status: 404 });
    row.status = status;
    row.ruling = ruling;
    row.updated_at = now;
    row.updated_by = session.username;
    return mapAppeal(row);
  }

  await ensureTourneyAppealPayoutSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    update tourney_appeals
    set status = ${status},
        ruling = ${ruling},
        updated_at = ${now},
        updated_by = ${session.username}
    where id = ${appealId}
    returning *
  `;
  if (!rows?.[0]) {
    throw Object.assign(new Error("Appeal not found."), { status: 404 });
  }
  return mapAppeal(rows[0]);
}

export async function listTourneyAppealsForSession({
  session,
  env = process.env,
} = {}) {
  assertAuthed(session);
  const rows = isMemoryMode(env)
    ? MEMORY_STORE.appeals
    : await (async () => {
        await ensureTourneyAppealPayoutSchema(env);
        const sql = await getSql(env);
        return sql`select * from tourney_appeals order by created_at desc`;
      })();
  return rows
    .map(mapAppeal)
    .filter(
      (appeal) =>
        isAdminSession(session) || appeal.submitterPlayerId === session.playerId
    )
    .sort((left, right) => String(right.createdAt).localeCompare(left.createdAt));
}

export async function upsertTourneyPayout({
  payload,
  session,
  env = process.env,
} = {}) {
  assertAdmin(session);
  const validation = await validatePayoutPayload({ payload, env });
  if (!validation.ok) {
    throw Object.assign(new Error(validation.errors[0] || "Invalid payout."), {
      status: 400,
      errors: validation.errors,
    });
  }
  const value = validation.value;
  const now = nowIso();
  const id = value.payoutId || crypto.randomUUID();
  const row = {
    id,
    player_id: value.playerId,
    display_name: value.displayName,
    team_name: value.teamName,
    payout_type: value.payoutType,
    amount_usd: value.amountUsd,
    status: value.status,
    payout_email: value.payoutEmail,
    notes: value.notes,
    created_at: now,
    updated_at: now,
    updated_by: session.username,
  };

  if (isMemoryMode(env)) {
    const index = MEMORY_STORE.payouts.findIndex((payout) => payout.id === id);
    if (index >= 0) {
      MEMORY_STORE.payouts[index] = {
        ...MEMORY_STORE.payouts[index],
        ...row,
        created_at: MEMORY_STORE.payouts[index].created_at,
      };
      return mapPayout(MEMORY_STORE.payouts[index]);
    }
    MEMORY_STORE.payouts.push(row);
    return mapPayout(row);
  }

  await ensureTourneyAppealPayoutSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    insert into tourney_payouts (
      id, player_id, display_name, team_name, payout_type, amount_usd,
      status, payout_email, notes, created_at, updated_at, updated_by
    )
    values (
      ${row.id}, ${row.player_id}, ${row.display_name}, ${row.team_name},
      ${row.payout_type}, ${row.amount_usd}, ${row.status}, ${row.payout_email},
      ${row.notes}, ${row.created_at}, ${row.updated_at}, ${row.updated_by}
    )
    on conflict (id) do update set
      player_id = excluded.player_id,
      display_name = excluded.display_name,
      team_name = excluded.team_name,
      payout_type = excluded.payout_type,
      amount_usd = excluded.amount_usd,
      status = excluded.status,
      payout_email = excluded.payout_email,
      notes = excluded.notes,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
    returning *
  `;
  return mapPayout(rows[0]);
}

export async function listTourneyPayoutsForSession({
  session,
  env = process.env,
} = {}) {
  assertAuthed(session);
  const rows = isMemoryMode(env)
    ? MEMORY_STORE.payouts
    : await (async () => {
        await ensureTourneyAppealPayoutSchema(env);
        const sql = await getSql(env);
        return sql`select * from tourney_payouts order by created_at desc`;
      })();
  return rows
    .map(mapPayout)
    .filter(
      (payout) => isAdminSession(session) || payout.playerId === session.playerId
    )
    .sort((left, right) => String(right.createdAt).localeCompare(left.createdAt));
}
