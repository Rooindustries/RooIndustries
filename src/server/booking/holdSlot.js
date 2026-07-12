import { createDataClient as createClient } from "../data/documentClient.js";
import crypto from "crypto";
import { issueHoldToken, verifyHoldToken } from "./holdToken.js";
import {
  buildBookingSlotId,
  buildSlotHoldId,
  isExactWholeMinute,
  normalizeStartTimeUTC,
} from "./slotIdentity.js";
import {
  getBookingSettings,
  isBookingBlockingStatus,
  isSlotAllowedForPackage,
} from "./slotPolicy.js";
import { getClientAddress, requireRateLimit } from "../api/ref/rateLimit.js";
import { logSafeError } from "../safeErrorLog.js";
import { resolveSupabaseRuntimePolicy } from "../supabase/runtime.js";
import { isSupabaseAdminConfigured } from "../supabase/adminClient.js";
import { assertCommerceStartAllowed } from "../supabase/commerceControl.js";

const createHoldClient = (backendOverride) =>
  createClient(
    {
      projectId: process.env.SANITY_PROJECT_ID,
      dataset: process.env.SANITY_DATASET || "production",
      apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
      token: process.env.SANITY_WRITE_TOKEN,
      useCdn: false,
    },
    { backendOverride, domain: "commerce" }
  );

export const HOLD_DURATION_MS = 20 * 60 * 1000;

const isConflict = (error) =>
  Number(error?.statusCode || error?.status || 0) === 409;

const isHoldActive = (hold, now = Date.now()) => {
  const phase = String(hold?.phase || "active").trim().toLowerCase();
  const expiresAt = new Date(hold?.expiresAt || "").getTime();
  return (
    phase !== "released" &&
    phase !== "consumed" &&
    Number.isFinite(expiresAt) &&
    expiresAt > now
  );
};

const normalizeBookingList = (bookings) =>
  Array.isArray(bookings) ? bookings : bookings ? [bookings] : [];

const hasBlockingBooking = (bookings) =>
  normalizeBookingList(bookings).some(
    (booking) =>
      !String(booking?.originalOrderId || "").trim() &&
      isBookingBlockingStatus(booking?.status)
  );

const fetchOtherBackendSlotState = async ({
  backend,
  holdId,
  slotLockId,
  startTimeUTC,
}) => {
  const otherBackend = backend === "supabase" ? "sanity" : "supabase";
  if (otherBackend === "supabase" && !isSupabaseAdminConfigured()) {
    return { hold: null, slotLock: null, bookings: [] };
  }
  const otherClient = createHoldClient(otherBackend);
  const [hold, slotLock, bookings] = await Promise.all([
    otherClient.fetch(`*[_type == "slotHold" && _id == $id][0]`, {
      id: holdId,
    }),
    otherClient.fetch(`*[_type == "bookingSlot" && _id == $id][0]`, {
      id: slotLockId,
    }),
    otherClient.fetch(
      `*[_type == "booking" && startTimeUTC == $startTimeUTC]{_id,status,originalOrderId}`,
      { startTimeUTC }
    ),
  ]);
  return { hold, slotLock, bookings };
};

const patchAtRevision = async (client, document, values, options = {}) => {
  let patch = client.patch(document._id);
  if (document?._rev && typeof patch.ifRevisionId === "function") {
    patch = patch.ifRevisionId(document._rev);
  }
  return patch.set(values).commit(options);
};

const issueResponse = ({
  hold,
  startTimeUTC,
  expiresAt,
  holdNonce,
  backend,
  res,
}) => {
  const cutoverGeneration = Number(
    hold?.cutoverGeneration ??
      resolveSupabaseRuntimePolicy().commerceFailoverGeneration ??
      0
  );
  const holdToken = issueHoldToken({
    holdId: hold._id,
    startTimeUTC,
    expiresAt,
    holdNonce,
    backend,
    cutoverGeneration,
  });
  return res.status(200).json({
    ok: true,
    holdId: hold._id,
    holdToken,
    expiresAt,
    backend,
    cutoverGeneration,
  });
};

const selectHoldBackend = ({
  previousHoldId,
  previousHoldToken,
  startTimeUTC,
  packageTitle,
  clientAddress,
}) => {
  const previous = verifyHoldToken({
    token: previousHoldToken,
    holdId: previousHoldId,
    ignoreExpiry: true,
  });
  if (previous?.hid) {
    return previous.be === "supabase" ? "supabase" : "sanity";
  }
  const policy = resolveSupabaseRuntimePolicy();
  return policy.commercePrimaryBackend === "supabase" ? "supabase" : "sanity";
};

const releasePreviousHold = async ({
  previousHoldId,
  previousHoldToken,
  currentHoldId,
}) => {
  if (!previousHoldId || previousHoldId === currentHoldId || !previousHoldToken) {
    return;
  }

  try {
    const previousTokenPayload = verifyHoldToken({
      token: previousHoldToken,
      holdId: previousHoldId,
      ignoreExpiry: true,
    });
    const previousBackend =
      previousTokenPayload?.be === "supabase" ? "supabase" : "sanity";
    const client = createHoldClient(previousBackend);
    const previousHold = await client.fetch(
      `*[_type == "slotHold" && _id == $id][0]`,
      { id: previousHoldId }
    );
    if (!previousHold?._id) return;
    if (
      String(previousHold.phase || "").trim().toLowerCase() ===
      "payment_pending"
    ) {
      return;
    }
    const validToken = verifyHoldToken({
      token: previousHoldToken,
      holdId: previousHoldId,
      startTimeUTC: previousHold.startTimeUTC,
      holdNonce: previousHold.holdNonce || "",
      backend:
        previousHold.backendOwner === "supabase" ? "supabase" : "sanity",
      cutoverGeneration: Number(previousHold.cutoverGeneration || 0),
    });
    if (!validToken) return;
    const releasedAt = new Date().toISOString();
    await patchAtRevision(
      client,
      previousHold,
      {
        phase: "released",
        releasedAt,
        expiresAt: releasedAt,
        holdNonce: crypto.randomUUID(),
      },
      previousBackend === "supabase" ? { deferMirror: true } : {}
    );
  } catch {
    // Moving to a new slot must not fail because a stale previous hold changed.
  }
};

export default async function handler(req, res) {
  if (String(req?.method || "").toUpperCase() !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  if (resolveSupabaseRuntimePolicy().commerceStartsPaused) {
    res.setHeader?.("Retry-After", "60");
    return res.status(503).json({
      ok: false,
      code: "commerce_starts_paused",
      message: "New booking starts are temporarily paused. Please try again shortly.",
    });
  }

  const { startTimeUTC, packageTitle, previousHoldId, previousHoldToken } =
    req.body || {};
  const clientAddress = getClientAddress(req);
  if (
    !(await requireRateLimit(res, {
      key: `hold-slot:${clientAddress}`,
      max: 20,
      message: "Too many slot hold requests. Please try again later.",
    }))
  ) {
    return;
  }

  let commerceControl;
  try {
    commerceControl = await assertCommerceStartAllowed();
  } catch (error) {
    res.setHeader?.("Retry-After", "60");
    return res.status(503).json({
      ok: false,
      code: String(error?.code || "commerce_control_unavailable").toLowerCase(),
      message: "New booking starts are temporarily unavailable. Please try again shortly.",
    });
  }

  const normalizedStartTimeUTC = normalizeStartTimeUTC(startTimeUTC);
  if (!normalizedStartTimeUTC || !isExactWholeMinute(normalizedStartTimeUTC)) {
    return res.status(400).json({
      ok: false,
      message: "startTimeUTC must be an exact configured minute.",
    });
  }

  const backend = selectHoldBackend({
    previousHoldId,
    previousHoldToken,
    startTimeUTC: normalizedStartTimeUTC,
    packageTitle,
    clientAddress,
  });
  const cutoverGeneration = commerceControl.generation;
  const client = createHoldClient(backend);
  const holdMutationOptions =
    backend === "supabase" ? { deferMirror: true } : {};

  try {
    const settings = await getBookingSettings({ client });
    const slot = isSlotAllowedForPackage({
      settings,
      packageTitle,
      startTimeUTC: normalizedStartTimeUTC,
    });
    if (!slot.allowed) {
      return res.status(400).json({
        ok: false,
        message: "This time is not available for the selected package.",
      });
    }

    const holdId = buildSlotHoldId(normalizedStartTimeUTC);
    const slotLockId = buildBookingSlotId(normalizedStartTimeUTC);
    if (previousHoldId && previousHoldId !== holdId && previousHoldToken) {
      const previousHold = await client.fetch(
        `*[_type == "slotHold" && _id == $id][0]`,
        { id: previousHoldId }
      );
      const ownsPreviousHold = previousHold?._id && verifyHoldToken({
        token: previousHoldToken,
        holdId: previousHoldId,
        startTimeUTC: previousHold.startTimeUTC,
        holdNonce: previousHold.holdNonce || "",
        backend:
          previousHold.backendOwner === "supabase" ? "supabase" : "sanity",
        cutoverGeneration: Number(previousHold.cutoverGeneration || 0),
      });
      if (
        ownsPreviousHold &&
        String(previousHold.phase || "").trim().toLowerCase() ===
          "payment_pending"
      ) {
        return res.status(409).json({
          ok: false,
          message: "The existing payment session must finish before changing slots.",
        });
      }
    }
    const [slotLock, matchingBookings] = await Promise.all([
      client.fetch(`*[_type == "bookingSlot" && _id == $id][0]`, {
        id: slotLockId,
      }),
      client.fetch(
        `*[_type == "booking" && startTimeUTC == $startTimeUTC]{_id,status,originalOrderId}`,
        { startTimeUTC: normalizedStartTimeUTC }
      ),
    ]);
    const matchingBookingList = normalizeBookingList(matchingBookings);
    const activeLegacyBooking = hasBlockingBooking(matchingBookingList);
    const lockOwner = matchingBookingList.find(
      (booking) => booking?._id === slotLock?.bookingId
    );
    const staleReleasedLock =
      slotLock?.status !== "released" &&
      lockOwner?._id &&
      (!!String(lockOwner.originalOrderId || "").trim() ||
        !isBookingBlockingStatus(lockOwner.status));
    if (staleReleasedLock) {
      try {
        await patchAtRevision(client, slotLock, {
          status: "released",
          releasedAt: new Date().toISOString(),
          releaseReason: "booking_status_repair",
        });
      } catch (error) {
        if (isConflict(error)) {
          return res.status(409).json({
            ok: false,
            message: "This slot changed while its booking status was repaired.",
          });
        }
        throw error;
      }
    }
    const activeLock =
      slotLock && slotLock.status !== "released" && !staleReleasedLock;
    if (activeLock || activeLegacyBooking) {
      return res.status(409).json({
        ok: false,
        message: "This slot is already booked.",
      });
    }

    const now = Date.now();
    const expiresAt = new Date(now + HOLD_DURATION_MS).toISOString();
    const otherBackendStatePromise = fetchOtherBackendSlotState({
      backend,
      holdId,
      slotLockId,
      startTimeUTC: normalizedStartTimeUTC,
    });
    const fetchHold = () =>
      client.fetch(`*[_type == "slotHold" && _id == $id][0]`, { id: holdId });
    const existingHold = await fetchHold();
    const otherBackendState = await otherBackendStatePromise;
    const mirroredSameHold =
      existingHold?._id &&
      otherBackendState.hold?._id === existingHold._id &&
      String(otherBackendState.hold.holdNonce || "") ===
        String(existingHold.holdNonce || "") &&
      String(otherBackendState.hold.expiresAt || "") ===
        String(existingHold.expiresAt || "");
    if (
      (otherBackendState.slotLock &&
        otherBackendState.slotLock.status !== "released") ||
      hasBlockingBooking(otherBackendState.bookings) ||
      (isHoldActive(otherBackendState.hold, now) && !mirroredSameHold)
    ) {
      return res.status(409).json({
        ok: false,
        message: "This slot is already reserved or booked.",
      });
    }

    // The booking can be reactivated after the first availability read. Recheck
    // after reading the deterministic hold barrier; from this point onward, its
    // revision guard makes the hold write and admin reactivation mutually exclusive.
    const [currentSlotLock, currentMatchingBookings] = await Promise.all([
      client.fetch(`*[_type == "bookingSlot" && _id == $id][0]`, {
        id: slotLockId,
      }),
      client.fetch(
        `*[_type == "booking" && startTimeUTC == $startTimeUTC]{_id,status,originalOrderId}`,
        { startTimeUTC: normalizedStartTimeUTC }
      ),
    ]);
    if (
      (currentSlotLock && currentSlotLock.status !== "released") ||
      hasBlockingBooking(currentMatchingBookings)
    ) {
      return res.status(409).json({
        ok: false,
        message: "This slot is already booked.",
      });
    }

    if (isHoldActive(existingHold, now)) {
      if (
        String(existingHold.phase || "").trim().toLowerCase() ===
        "payment_pending"
      ) {
        return res.status(409).json({
          ok: false,
          message: "This slot already has a payment session in progress.",
        });
      }
      const mayRefresh =
        previousHoldId === holdId &&
        verifyHoldToken({
          token: previousHoldToken,
          holdId,
          startTimeUTC: existingHold.startTimeUTC || normalizedStartTimeUTC,
          holdNonce: existingHold.holdNonce || "",
          backend:
            existingHold.backendOwner === "supabase" ? "supabase" : "sanity",
          cutoverGeneration: Number(existingHold.cutoverGeneration || 0),
        });
      if (!mayRefresh) {
        return res.status(409).json({
          ok: false,
          message: "This slot is currently reserved by someone else.",
        });
      }

      const holdNonce = crypto.randomUUID();
      try {
        const refreshed = await patchAtRevision(
          client,
          existingHold,
          {
            packageTitle: String(packageTitle || "").trim(),
            startTimeUTC: normalizedStartTimeUTC,
            hostDate: slot.hostDate,
            hostTime: slot.hostTime,
            expiresAt,
            phase: "active",
            releasedAt: "",
            consumedAt: "",
            paymentRecordId: "",
            holdNonce,
            backendOwner: backend,
            cutoverGeneration,
          },
          holdMutationOptions
        );
        return issueResponse({
          hold: refreshed || existingHold,
          startTimeUTC: normalizedStartTimeUTC,
          expiresAt,
          holdNonce,
          backend,
          res,
        });
      } catch (error) {
        if (isConflict(error)) {
          return res.status(409).json({
            ok: false,
            message: "This slot changed while it was being refreshed.",
          });
        }
        throw error;
      }
    }

    const holdNonce = crypto.randomUUID();
    const holdValues = {
      _id: holdId,
      _type: "slotHold",
      hostDate: slot.hostDate,
      hostTime: slot.hostTime,
      startTimeUTC: normalizedStartTimeUTC,
      packageTitle: String(packageTitle || "").trim(),
      expiresAt,
      holdNonce,
      phase: "active",
      backendOwner: backend,
      cutoverGeneration,
      releasedAt: "",
      consumedAt: "",
      paymentRecordId: "",
    };

    let created;
    try {
      created = existingHold
        ? await patchAtRevision(
            client,
            existingHold,
            holdValues,
            holdMutationOptions
          )
        : await client.create(holdValues, holdMutationOptions);
    } catch (error) {
      if (isConflict(error)) {
        return res.status(409).json({
          ok: false,
          message: "This slot is currently being reserved. Please try again.",
        });
      }
      throw error;
    }

    try {
      const response = issueResponse({
        hold: created || holdValues,
        startTimeUTC: normalizedStartTimeUTC,
        expiresAt,
        holdNonce,
        backend,
        res,
      });
      await releasePreviousHold({
        previousHoldId,
        previousHoldToken,
        currentHoldId: holdId,
      });
      return response;
    } catch (error) {
      const failedAt = new Date().toISOString();
      await patchAtRevision(
        client,
        created || holdValues,
        {
          phase: "released",
          releasedAt: failedAt,
          expiresAt: failedAt,
          holdNonce: crypto.randomUUID(),
        },
        holdMutationOptions
      ).catch(() => {});
      throw error;
    }
  } catch (error) {
    logSafeError("Slot hold failed", error);
    return res.status(500).json({
      ok: false,
      message: "Failed to reserve this slot. Please try again.",
    });
  }
}
