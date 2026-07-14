import crypto from "crypto";
import { getManageTourneyPlayerById } from "./playerStore.js";
import {
  assertTourneySchemaVersion,
  getTourneySql as getSql,
  isSupabaseTourneyDatabase,
  resolveTourneyDatabaseUrl as getDatabaseUrl,
  runTourneyTransaction,
} from "./sqlClient.js";

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
const nowIso = () => new Date().toISOString();
const normalizeText = (value) => String(value || "").trim();
const normalizeKey = (value) => normalizeText(value).toLowerCase();
const isAdminSession = (session = null) =>
  session?.role === "owner" || session?.role === "caster";
const isPlayerSession = (session = null) => session?.role === "player";

const isMemoryMode = (env = process.env) =>
  env.TOURNEY_APPEAL_PAYOUT_STORE_MODE === "memory" ||
  env.TOURNEY_DATABASE_MODE === "memory";

export const resetMemoryTourneyAppealPayoutStoreForTests = () => {
  MEMORY_STORE.appeals = [];
  MEMORY_STORE.payouts = [];
};

export async function ensureTourneyAppealPayoutSchema(env = process.env) {
  if (isMemoryMode(env)) return;
  await assertTourneySchemaVersion(env);
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
  const evidenceUrl = normalizeText(payload.evidenceUrl);
  if (!type) errors.push("Choose an appeal type.");
  if (title.length < 3) errors.push("Appeal title is required.");
  if (title.length > 160) errors.push("Appeal title must be 160 characters or less.");
  if (details.length < 3) errors.push("Appeal details are required.");
  if (details.length > 5000) errors.push("Appeal details must be 5,000 characters or less.");
  if (evidenceUrl.length > 2048) errors.push("Evidence link is too long.");
  if (evidenceUrl) {
    try {
      const parsed = new URL(evidenceUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("scheme");
    } catch {
      errors.push("Evidence link must use http or https.");
    }
  }
  const boundedFields = [
    [payload.teamName, "Team name", 160],
    [payload.captainName, "Captain name", 160],
    [payload.subjectName, "Subject name", 160],
    [payload.subjectPlayerId, "Subject player", 200],
    [payload.ruling, "Ruling", 5000],
  ];
  for (const [field, label, max] of boundedFields) {
    if (normalizeText(field).length > max) errors.push(`${label} is too long.`);
  }
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
      evidenceUrl,
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
  const payoutEmail = normalizeKey(payload.payoutEmail);
  const errors = [];
  if (!playerId) errors.push("Choose a player.");
  if (!payoutType) errors.push("Choose a payout type.");
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    errors.push("Amount must be zero or higher.");
  } else if (amountUsd > 99_999_999.99) {
    errors.push("Amount is too large.");
  } else if (Math.abs(Math.round(amountUsd * 100) - amountUsd * 100) > 1e-8) {
    errors.push("Amount can have at most two decimal places.");
  }
  const requiresNotification = ["ready", "paid", "void"].includes(status);
  const validPayoutEmail = payoutEmail.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payoutEmail);
  if ((requiresNotification || payoutEmail) && !validPayoutEmail) {
    errors.push(
      requiresNotification
        ? "A valid payout email is required for this status."
        : "Enter a valid payout email."
    );
  }
  if (normalizeText(payload.teamName).length > 160) errors.push("Team name is too long.");
  if (normalizeText(payload.notes).length > 2000) errors.push("Notes are too long.");

  const player = playerId
    ? await getManageTourneyPlayerById({ playerId, env })
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
      payoutEmail,
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
  if (ruling.length > 5000) {
    throw Object.assign(new Error("Ruling must be 5,000 characters or less."), {
      status: 400,
    });
  }
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
        if (isSupabaseTourneyDatabase(env) && !isAdminSession(session)) {
          return sql`
            select id, type, status, team_name, captain_name,
              submitter_player_id, submitter_username, subject_player_id,
              subject_name, title, details, evidence_url, ruling, created_at,
              updated_at, updated_by
            from tourney_appeals
            where submitter_player_id = ${session.playerId}
            order by created_at desc, id desc
            limit 100
          `;
        }
        return isSupabaseTourneyDatabase(env)
          ? sql`
              select id, type, status, team_name, captain_name,
                submitter_player_id, submitter_username, subject_player_id,
                subject_name, title, details, evidence_url, ruling, created_at,
                updated_at, updated_by
              from tourney_appeals
              order by created_at desc, id desc
              limit 100
            `
          : sql`
              select id, type, status, team_name, captain_name,
                submitter_player_id, submitter_username, subject_player_id,
                subject_name, title, details, evidence_url, ruling, created_at,
                updated_at, updated_by
              from tourney_appeals
              order by created_at desc, id desc
            `;
      })();
  return rows
    .map(mapAppeal)
    .filter(
      (appeal) =>
        isAdminSession(session) || appeal.submitterPlayerId === session.playerId
    )
    .sort((left, right) => String(right.createdAt).localeCompare(left.createdAt));
}

const buildPayoutRow = ({ value, session }) => {
  const now = nowIso();
  return {
    id: value.payoutId || crypto.randomUUID(),
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
};

const PAYOUT_TERMINAL_STATUSES = new Set(["paid", "void"]);
const PAYOUT_LOCKED_FINANCIAL_STATUSES = new Set(["ready", "paid", "void"]);
const PAYOUT_FINANCIAL_FIELDS = Object.freeze([
  "player_id",
  "payout_type",
  "amount_usd",
  "payout_email",
]);

const assertPayoutTransition = ({ existing, row }) => {
  if (!existing) return;
  if (
    PAYOUT_TERMINAL_STATUSES.has(existing.status) &&
    row.status !== existing.status
  ) {
    throw Object.assign(new Error("Paid and void payouts are terminal."), {
      code: "TOURNEY_PAYOUT_TERMINAL",
      status: 409,
    });
  }
  if (
    existing.status === "ready" &&
    !["ready", "paid", "void"].includes(row.status)
  ) {
    throw Object.assign(new Error("Ready payouts can only become paid or void."), {
      code: "TOURNEY_PAYOUT_STATUS_REGRESSION",
      status: 409,
    });
  }
  if (!PAYOUT_LOCKED_FINANCIAL_STATUSES.has(existing.status)) return;
  const changed = PAYOUT_FINANCIAL_FIELDS.some((field) => {
    if (field === "amount_usd") {
      return Math.round(Number(existing[field]) * 100) !==
        Math.round(Number(row[field]) * 100);
    }
    return String(existing[field] ?? "") !== String(row[field] ?? "");
  });
  if (changed) {
    throw Object.assign(
      new Error("Financial payout details cannot change after the payout is ready."),
      { code: "TOURNEY_PAYOUT_FINANCIALS_LOCKED", status: 409 }
    );
  }
};

const upsertMemoryPayoutWithTransition = (row) => {
  const index = MEMORY_STORE.payouts.findIndex((payout) => payout.id === row.id);
  const previousStatus = index >= 0 ? MEMORY_STORE.payouts[index].status : "";
  if (index < 0) {
    MEMORY_STORE.payouts.push(row);
    return { payout: mapPayout(row), previousStatus };
  }

  assertPayoutTransition({ existing: MEMORY_STORE.payouts[index], row });

  MEMORY_STORE.payouts[index] = {
    ...MEMORY_STORE.payouts[index],
    ...row,
    created_at: MEMORY_STORE.payouts[index].created_at,
  };
  return { payout: mapPayout(MEMORY_STORE.payouts[index]), previousStatus };
};

const upsertDatabasePayoutWithTransition = async ({ row, env }) => {
  const lockKey = `roo-tourney-payout:${row.id}`;
  return runTourneyTransaction({
    env,
    lockKey,
    waitForLock: true,
    callback: async (sql) => {
      await sql`
        select pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${lockKey}, 0)
        )
      `;
      const existing = await sql`
        select status, player_id, payout_type, amount_usd, payout_email
        from tourney_payouts where id = ${row.id} for update
      `;
      assertPayoutTransition({ existing: existing[0], row });
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
      return {
        payout: mapPayout(rows[0]),
        previousStatus: existing[0]?.status || "",
      };
    },
  });
};

export async function upsertTourneyPayoutWithTransition({
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

  const row = buildPayoutRow({ value: validation.value, session });
  if (isMemoryMode(env)) return upsertMemoryPayoutWithTransition(row);
  await ensureTourneyAppealPayoutSchema(env);
  return upsertDatabasePayoutWithTransition({ row, env });
}

export async function upsertTourneyPayout(options = {}) {
  const result = await upsertTourneyPayoutWithTransition(options);
  return result.payout;
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
        if (isSupabaseTourneyDatabase(env) && !isAdminSession(session)) {
          return sql`
            select id, player_id, display_name, team_name, payout_type,
              amount_usd, status, payout_email, notes, created_at, updated_at,
              updated_by
            from tourney_payouts
            where player_id = ${session.playerId}
            order by created_at desc, id desc
            limit 100
          `;
        }
        return isSupabaseTourneyDatabase(env)
          ? sql`
              select id, player_id, display_name, team_name, payout_type,
                amount_usd, status, payout_email, notes, created_at, updated_at,
                updated_by
              from tourney_payouts
              order by created_at desc, id desc
              limit 100
            `
          : sql`
              select id, player_id, display_name, team_name, payout_type,
                amount_usd, status, payout_email, notes, created_at, updated_at,
                updated_by
              from tourney_payouts
              order by created_at desc, id desc
            `;
      })();
  return rows
    .map(mapPayout)
    .filter(
      (payout) => isAdminSession(session) || payout.playerId === session.playerId
    )
    .sort((left, right) => String(right.createdAt).localeCompare(left.createdAt));
}
