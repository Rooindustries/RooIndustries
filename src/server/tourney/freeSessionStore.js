import crypto from "node:crypto";
import {
  isExactWholeMinute,
  normalizeStartTimeUTC,
} from "../booking/slotIdentity.js";
import {
  assertTourneySchemaVersion,
  getTourneySql as getSql,
  runTourneyTransaction,
} from "./sqlClient.js";

export const TOURNEY_FREE_SESSION_PACKAGE_TITLE = "Tourney Free Optimization";
export const TOURNEY_FREE_SESSION_AVAILABILITY_URL = "/api/bookingAvailability";

const MEMORY_STORE =
  globalThis.__rooTourneyFreeSessionStore ||
  (globalThis.__rooTourneyFreeSessionStore = {
    entitlements: [],
    bookingPlayers: new Set(),
  });

const nowIso = () => new Date().toISOString();
const normalizeText = (value) => String(value || "").trim();
const isMemoryMode = (env = process.env) =>
  env.TOURNEY_FREE_SESSION_STORE_MODE === "memory" ||
  env.TOURNEY_PLAYER_STORE_MODE === "memory" ||
  env.TOURNEY_DATABASE_MODE === "memory";

const createApiError = (message, status, code = "") =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

const createMemoryResponse = () => {
  const state = { status: 200, body: null, headers: {} };
  return {
    status(code) {
      state.status = Number(code) || 200;
      return this;
    },
    json(body) {
      state.body = body;
      return body;
    },
    setHeader(name, value) {
      state.headers[String(name || "").toLowerCase()] = value;
    },
    __state: state,
  };
};

const runInternalHandler = async ({ handler, body, clientAddress }) => {
  const response = createMemoryResponse();
  await handler(
    {
      method: "POST",
      body,
      headers: { "x-forwarded-for": clientAddress || "127.0.0.1" },
    },
    response
  );
  return response.__state;
};

const normalizeBookingPayload = (payload = {}) => {
  const startTimeUTC = normalizeStartTimeUTC(payload.startTimeUTC);
  const email = normalizeText(payload.email).toLowerCase();
  const discord = normalizeText(payload.discord);
  const specs = normalizeText(payload.specs);
  const mainGame = normalizeText(payload.mainGame);
  const timezone = normalizeText(payload.timezone);
  const errors = [];

  if (!startTimeUTC || !isExactWholeMinute(startTimeUTC)) {
    errors.push("Choose an available session time.");
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("Enter a valid email address.");
  }
  if (!discord) errors.push("Discord is required.");
  if (discord.length > 200) errors.push("Discord is too long.");
  if (!specs) errors.push("PC specifications are required.");
  if (specs.length > 4000) errors.push("PC specifications are too long.");
  if (!mainGame) errors.push("Main game is required.");
  if (mainGame.length > 200) errors.push("Main game is too long.");
  try {
    if (!timezone) throw new Error("missing");
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    errors.push("Choose a valid timezone.");
  }

  if (errors.length > 0) {
    throw Object.assign(new Error(errors[0]), { status: 400, errors });
  }
  return { startTimeUTC, email, discord, specs, mainGame, timezone };
};

const mapEntitlement = (row = null) => {
  if (!row) return null;
  const bookingId = normalizeText(row.booking_id ?? row.bookingId);
  const startTimeUTC = normalizeText(
    row.booking_start_time_utc ?? row.bookingStartTimeUTC
  );
  const bookingStatus = normalizeText(row.booking_status ?? row.bookingStatus);
  return {
    id: normalizeText(row.id),
    status: normalizeText(row.status),
    bookingId,
    consumedAt: normalizeText(row.consumed_at ?? row.consumedAt),
    booking: bookingId
      ? { id: bookingId, startTimeUTC, status: bookingStatus }
      : null,
  };
};

const buildState = (row = null) => ({
  ok: true,
  packageTitle: TOURNEY_FREE_SESSION_PACKAGE_TITLE,
  availabilityUrl: TOURNEY_FREE_SESSION_AVAILABILITY_URL,
  entitlement: mapEntitlement(row),
});

export const resetMemoryTourneyFreeSessionStoreForTests = () => {
  MEMORY_STORE.entitlements = [];
  MEMORY_STORE.bookingPlayers = new Set();
};

export async function ensureTourneyFreeSessionSchema(env = process.env) {
  if (isMemoryMode(env)) return;
  await assertTourneySchemaVersion(env);
}

export async function grantTourneySessionEntitlement({
  playerId,
  actorUsername = "system",
  env = process.env,
} = {}) {
  const normalizedPlayerId = normalizeText(playerId);
  if (!normalizedPlayerId) {
    throw new Error("A Tourney player ID is required for an entitlement.");
  }

  if (isMemoryMode(env)) {
    const existing = MEMORY_STORE.entitlements.find(
      (entry) => entry.player_id === normalizedPlayerId
    );
    if (existing) return mapEntitlement(existing);
    const timestamp = nowIso();
    const row = {
      id: crypto.randomUUID(),
      player_id: normalizedPlayerId,
      status: "available",
      booking_id: "",
      consumed_at: "",
      created_at: timestamp,
      updated_at: timestamp,
      updated_by: normalizeText(actorUsername) || "system",
      booking_start_time_utc: "",
      booking_status: "",
    };
    MEMORY_STORE.entitlements.push(row);
    return mapEntitlement(row);
  }

  await ensureTourneyFreeSessionSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    insert into tourney_session_entitlements (
      player_id, status, updated_by
    ) values (
      ${normalizedPlayerId}, 'available', ${normalizeText(actorUsername) || "system"}
    )
    on conflict (player_id) do nothing
    returning *
  `;
  if (rows?.[0]) return mapEntitlement(rows[0]);
  const existing = await sql`
    select id, player_id, status, booking_id, consumed_at
    from tourney_session_entitlements
    where player_id = ${normalizedPlayerId}
    limit 1
  `;
  return mapEntitlement(existing?.[0] || null);
}

export async function getTourneyFreeSessionState({
  playerId,
  env = process.env,
} = {}) {
  const normalizedPlayerId = normalizeText(playerId);
  if (!normalizedPlayerId) return buildState(null);

  if (isMemoryMode(env)) {
    const row = MEMORY_STORE.entitlements.find(
      (entry) => entry.player_id === normalizedPlayerId
    );
    return buildState(row || null);
  }

  await ensureTourneyFreeSessionSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select entitlement.id, entitlement.status, entitlement.booking_id,
      entitlement.consumed_at, booking.start_time_utc as booking_start_time_utc,
      booking.status as booking_status
    from tourney_session_entitlements entitlement
    left join commerce.bookings booking on booking.id = entitlement.booking_id
    where entitlement.player_id = ${normalizedPlayerId}
    limit 1
  `;
  return buildState(rows?.[0] || null);
}

const acquireSlotHold = async ({ value, clientAddress }) => {
  const { default: holdSlotHandler } = await import("../booking/holdSlot.js");
  const result = await runInternalHandler({
    handler: holdSlotHandler,
    body: {
      startTimeUTC: value.startTimeUTC,
      packageTitle: TOURNEY_FREE_SESSION_PACKAGE_TITLE,
    },
    clientAddress,
  });
  if (result.status >= 200 && result.status < 300 && result.body?.ok) {
    return result.body;
  }
  const status = result.status === 409 ? 409 : result.status >= 400 ? result.status : 500;
  throw createApiError(
    normalizeText(result.body?.message || result.body?.error) ||
      "Unable to reserve this session time.",
    status,
    status === 409 ? "TOURNEY_FREE_SESSION_SLOT_CONFLICT" : ""
  );
};

const releaseSlotHold = async ({ hold, clientAddress }) => {
  if (!hold?.holdId || !hold?.holdToken) return;
  const { default: releaseHoldHandler } = await import("../booking/releaseHold.js");
  await runInternalHandler({
    handler: releaseHoldHandler,
    body: { holdId: hold.holdId, holdToken: hold.holdToken },
    clientAddress,
  }).catch(() => null);
};

const createCapturedBooking = async ({ value, clientAddress }) => {
  const hold = await acquireSlotHold({ value, clientAddress });
  const backend = hold.backend === "sanity" ? "sanity" : "supabase";
  const [{ createPaymentBackendClient }, { startPaymentSession }] =
    await Promise.all([
      import("../api/payment/backend.js"),
      import("../api/payment/flow.js"),
    ]);
  const client = createPaymentBackendClient(backend);
  try {
    const result = await startPaymentSession({
      body: {
        provider: "free",
        bookingPayload: {
          packageTitle: TOURNEY_FREE_SESSION_PACKAGE_TITLE,
          startTimeUTC: value.startTimeUTC,
          email: value.email,
          discord: value.discord,
          specs: value.specs,
          mainGame: value.mainGame,
          message: "",
          localTimeZone: value.timezone,
          slotHoldId: hold.holdId,
          slotHoldToken: hold.holdToken,
          slotHoldExpiresAt: hold.expiresAt,
        },
      },
      client,
      backend,
      cutoverGeneration: Number(hold.cutoverGeneration || 0),
      authorizedFreeCheckout: true,
    });
    const bookingReference = normalizeText(result.body?.bookingId);
    if (
      result.httpStatus < 200 ||
      result.httpStatus >= 300 ||
      result.body?.ok !== true ||
      !bookingReference
    ) {
      const status = result.httpStatus === 409
        ? 409
        : result.httpStatus >= 400 && result.httpStatus < 500
          ? result.httpStatus
          : 500;
      throw createApiError(
        normalizeText(result.body?.error || result.body?.recoveryReason) ||
          "Unable to book this free session.",
        status,
        status === 409 ? "TOURNEY_FREE_SESSION_SLOT_CONFLICT" : ""
      );
    }
    return { backend, bookingReference, client, hold };
  } catch (error) {
    await releaseSlotHold({ hold, clientAddress });
    throw error;
  }
};

const getMemoryBooking = async ({ client, bookingReference }) => {
  const booking = await client.fetch(
    `*[_type == "booking" && _id == $id][0]{...}`,
    { id: bookingReference }
  );
  if (!booking?._id || booking.status !== "captured") {
    throw new Error("Captured Tourney booking could not be verified.");
  }
  return {
    id: booking._id,
    start_time_utc: booking.startTimeUTC || "",
    status: booking.status,
  };
};

const getDatabaseBooking = async ({ sql, bookingReference }) => {
  const rows = await sql`
    select id::text as id, start_time_utc, status, package_title, amount_subunits
    from commerce.bookings
    where id::text = ${bookingReference}
      or legacy_sanity_id = ${bookingReference}
    limit 1
  `;
  const booking = rows?.[0];
  if (
    !booking?.id ||
    !["captured", "completed"].includes(booking.status) ||
    booking.package_title !== TOURNEY_FREE_SESSION_PACKAGE_TITLE ||
    Number(booking.amount_subunits || 0) !== 0
  ) {
    throw new Error("Captured Tourney booking could not be verified.");
  }
  return booking;
};

export async function cancelTourneyFreeSessionBooking({
  bookingReference,
  backend = "supabase",
  client = null,
} = {}) {
  const normalizedBookingReference = normalizeText(bookingReference);
  if (!normalizedBookingReference) return;
  const [{ applyBookingStatusTransition }, { createPaymentBackendClient }] =
    await Promise.all([
      import("../api/ref/bookingRefunds.js"),
      import("../api/payment/backend.js"),
    ]);
  const writeClient = client || createPaymentBackendClient(backend);
  await applyBookingStatusTransition({
    client: writeClient,
    bookingId: normalizedBookingReference,
    status: "cancelled",
    source: "tourney-free-session-compensation",
  });
}

const assertAvailableEntitlement = (row) => {
  if (!row) {
    throw createApiError(
      "Free session entitlement is not available.",
      409,
      "TOURNEY_FREE_SESSION_UNAVAILABLE"
    );
  }
  if (row.status === "consumed") {
    throw createApiError(
      "Your free session has already been booked.",
      409,
      "TOURNEY_FREE_SESSION_ALREADY_BOOKED"
    );
  }
  if (row.status !== "available") {
    throw createApiError(
      "Free session entitlement is not available.",
      409,
      "TOURNEY_FREE_SESSION_UNAVAILABLE"
    );
  }
};

const bookMemoryTourneyFreeSession = async ({
  session,
  value,
  clientAddress,
}) => {
  const playerId = normalizeText(session.playerId);
  const row = MEMORY_STORE.entitlements.find(
    (entry) => entry.player_id === playerId
  );
  assertAvailableEntitlement(row);
  if (MEMORY_STORE.bookingPlayers.has(playerId)) {
    throw createApiError(
      "Your free session booking is already in progress.",
      409,
      "TOURNEY_FREE_SESSION_BUSY"
    );
  }

  MEMORY_STORE.bookingPlayers.add(playerId);
  let created = null;
  try {
    created = await createCapturedBooking({ value, clientAddress });
    const booking = await getMemoryBooking(created);
    const consumedAt = nowIso();
    row.status = "consumed";
    row.booking_id = booking.id;
    row.consumed_at = consumedAt;
    row.updated_at = consumedAt;
    row.updated_by = session.username;
    row.booking_start_time_utc = booking.start_time_utc;
    row.booking_status = booking.status;
    return {
      body: buildState(row),
      compensation: {
        bookingReference: created.bookingReference,
        backend: created.backend,
      },
    };
  } catch (error) {
    if (created?.bookingReference) {
      await cancelTourneyFreeSessionBooking({
        bookingReference: created.bookingReference,
        backend: created.backend,
        client: created.client,
      }).catch(() => null);
    }
    throw error;
  } finally {
    MEMORY_STORE.bookingPlayers.delete(playerId);
  }
};

export async function bookTourneyFreeSession({
  session,
  payload,
  clientAddress = "",
  env = process.env,
} = {}) {
  if (session?.role !== "player" || !normalizeText(session.playerId)) {
    throw createApiError("Not found.", 404);
  }
  const value = normalizeBookingPayload(payload);
  if (isMemoryMode(env)) {
    return bookMemoryTourneyFreeSession({ session, value, clientAddress });
  }

  let created = null;
  try {
    const result = await runTourneyTransaction({
      env,
      lockKey: `roo-tourney-free-session:${session.playerId}`,
      waitForLock: true,
      callback: async (sql) => {
        const playerLockKey = `roo-tourney-free-session:${session.playerId}`;
        await sql`
          select pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(${playerLockKey}, 0)
          )
        `;
        // The captured-booking call below round-trips a separate commerce
        // backend while this transaction holds the player lock; bound the
        // idle window so a hung downstream call cannot pin it indefinitely.
        await sql`set local idle_in_transaction_session_timeout = '120s'`;
        const players = await sql`
          select id, status
          from tourney_players
          where id = ${session.playerId}
          limit 1
          for update
        `;
        if (players?.[0]?.status !== "approved") {
          throw createApiError("Not found.", 404);
        }
        const rows = await sql`
          select id, player_id, status, booking_id, consumed_at
          from tourney_session_entitlements
          where player_id = ${session.playerId}
          limit 1
          for update
        `;
        const entitlement = rows?.[0];
        assertAvailableEntitlement(entitlement);

        created = await createCapturedBooking({ value, clientAddress });
        const booking = await getDatabaseBooking({
          sql,
          bookingReference: created.bookingReference,
        });
        const consumed = await sql`
          update tourney_session_entitlements
          set status = 'consumed', booking_id = ${booking.id}::uuid,
              consumed_at = now(), updated_at = now(),
              updated_by = ${session.username}
          where player_id = ${session.playerId}
            and status = 'available'
          returning id, status, booking_id, consumed_at
        `;
        // UNIQUE(player_id), this row lock, and the one-way available -> consumed
        // predicate are the invariant that prevents a player receiving two bookings.
        if (!consumed?.[0]) {
          throw createApiError(
            "Your free session has already been booked.",
            409,
            "TOURNEY_FREE_SESSION_ALREADY_BOOKED"
          );
        }
        return {
          body: buildState({
            ...consumed[0],
            booking_start_time_utc: booking.start_time_utc,
            booking_status: booking.status,
          }),
          compensation: {
            bookingReference: created.bookingReference,
            backend: created.backend,
          },
        };
      },
    });
    return result;
  } catch (error) {
    if (created?.bookingReference) {
      await cancelTourneyFreeSessionBooking({
        bookingReference: created.bookingReference,
        backend: created.backend,
        client: created.client,
      }).catch(() => null);
    }
    throw error;
  }
}
