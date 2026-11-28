import { createCommerceWriteClient } from "../api/ref/documentStore.js";
import crypto from "crypto";
import { issueHoldToken, verifyHoldToken } from "./holdToken.js";
import { selectHoldAuthority } from "./holdAuthority.js";
import { holdOwnsSlot } from "./holdOwnership.js";
import {
  buildBookingSlotId,
  buildSlotHoldId,
  isExactWholeMinute,
  normalizeStartTimeUTC,
} from "./slotIdentity.js";
import {
  BOOKING_SETTINGS_ID,
  getBookingSettings,
  hydrateBookingSettings,
  isBookingBlockingStatus,
  isSlotAllowedForPackage,
} from "./slotPolicy.js";
import { getClientAddress, requireRateLimit } from "../api/ref/rateLimit.js";
import { logSafeError } from "../safeErrorLog.js";
import { resolveSupabaseRuntimePolicy } from "../supabase/runtime.js";
import { assertCommerceStartAllowed } from "../supabase/commerceControl.js";
import { normalizePaymentFailureCount } from "../api/payment/paymentFailureReason.js";

const createHoldClient = (backendOverride) =>
  createCommerceWriteClient({ backendOverride });
export const HOLD_DURATION_MS = 20 * 60 * 1000;

const isConflict = (error) =>
  Number(error?.statusCode || error?.status || 0) === 409;

const isNotFound = (error) =>
  Number(error?.statusCode || error?.status || 0) === 404;

const normalizeBookingList = (bookings) =>
  Array.isArray(bookings) ? bookings : bookings ? [bookings] : [];

const hasBlockingBooking = (bookings) =>
  normalizeBookingList(bookings).some(
    (booking) =>
      !String(booking?.originalOrderId || "").trim() &&
      isBookingBlockingStatus(booking?.status)
  );

const patchAtRevision = async (client, document, values, options = {}) => {
  let patch = client.patch(document._id);
  if (document?._rev && typeof patch.ifRevisionId === "function") {
    patch = patch.ifRevisionId(document._rev);
  }
  return patch.set(values).commit({
    ...options,
    ...(document?._rev ? { baseDocument: document } : {}),
  });
};

const settle = (promise) =>
  Promise.resolve(promise).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );

const unwrapSettled = (result) => {
  if (!result?.ok) throw result?.error;
  return result.value;
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

export const selectHoldBackend = ({
  previousHoldId,
  previousHoldToken,
}) => {
  const previous = verifyHoldToken({
    token: previousHoldToken,
    holdId: previousHoldId,
    ignoreExpiry: true,
  });
  const policy = resolveSupabaseRuntimePolicy();
  return selectHoldAuthority({
    tokenPayload: previous,
    fallbackBackend: policy.commercePrimaryBackend,
    policy,
  });
};

const releasePreviousHold = async ({
  previousHoldId,
  previousHoldToken,
  currentHoldId,
  prefetchedHold,
  prefetchedBackend,
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
    const policy = resolveSupabaseRuntimePolicy();
    const previousBackend = selectHoldAuthority({
      tokenPayload: previousTokenPayload,
      fallbackBackend: policy.commercePrimaryBackend,
      policy,
    });
    const client = createHoldClient(previousBackend);
    const previousHold =
      prefetchedHold !== undefined && prefetchedBackend === previousBackend
        ? prefetchedHold
        : await client.fetch(
            `*[_type == "slotHold" && _id == $id][0]`,
            { id: previousHoldId }
          );
    if (!previousHold?._id) return;
    const phase = String(previousHold.phase || "").trim().toLowerCase();
    if (phase === "payment_pending" || phase === "released") {
      return;
    }
    const validToken = verifyHoldToken({
      token: previousHoldToken,
      holdId: previousHoldId,
      startTimeUTC: previousHold.startTimeUTC,
      holdNonce: previousHold.holdNonce || "",
      backend: previousHold.backendOwner,
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
      {}
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

  const normalizedStartTimeUTC = normalizeStartTimeUTC(startTimeUTC);
  const validStartTime = Boolean(
    normalizedStartTimeUTC && isExactWholeMinute(normalizedStartTimeUTC)
  );
  const backend = selectHoldBackend({
    previousHoldId,
    previousHoldToken,
  });

  const commerceControlPromise = settle(assertCommerceStartAllowed());

  let client = null;
  let clientError = null;
  const holdId = validStartTime ? buildSlotHoldId(normalizedStartTimeUTC) : "";
  const slotLockId = validStartTime ? buildBookingSlotId(normalizedStartTimeUTC) : "";
  const wantsPreviousHold = Boolean(
    validStartTime && previousHoldId && previousHoldId !== holdId && previousHoldToken
  );

  let prefetchedBatch = null;
  let prefetchedBookings = null;
  let prefetchedLegacy = null;
  if (validStartTime) {
    try {
      client = createHoldClient(backend);
      if (typeof client.getDocumentsByIds === "function") {
        const batchIds = [
          BOOKING_SETTINGS_ID,
          slotLockId,
          holdId,
          ...(wantsPreviousHold ? [previousHoldId] : []),
        ];
        prefetchedBatch = settle(
          client.getDocumentsByIds(batchIds, {
            documentTypes: ["bookingSettings", "bookingSlot", "slotHold"],
          })
        );
        prefetchedBookings = settle(
          client.fetch(
            `*[_type == "booking" && startTimeUTC == $startTimeUTC]{_id,status,originalOrderId}`,
            { startTimeUTC: normalizedStartTimeUTC }
          )
        );
      } else {
        prefetchedLegacy = {
          settings: settle(getBookingSettings({ client })),
          slotLock: settle(
            client.fetch(`*[_type == "bookingSlot" && _id == $id][0]`, {
              id: slotLockId,
            })
          ),
          bookings: settle(
            client.fetch(
              `*[_type == "booking" && startTimeUTC == $startTimeUTC]{_id,status,originalOrderId}`,
              { startTimeUTC: normalizedStartTimeUTC }
            )
          ),
          existingHold: settle(
            client.fetch(`*[_type == "slotHold" && _id == $id][0]`, {
              id: holdId,
            })
          ),
          previousHold: wantsPreviousHold
            ? settle(
                client.fetch(`*[_type == "slotHold" && _id == $id][0]`, {
                  id: previousHoldId,
                })
              )
            : null,
        };
      }
    } catch (error) {
      clientError = error;
    }
  }

  const controlResult = await commerceControlPromise;
  if (!controlResult.ok) {
    res.setHeader?.("Retry-After", "60");
    return res.status(503).json({
      ok: false,
      code: String(controlResult.error?.code || "commerce_control_unavailable").toLowerCase(),
      message: "New booking starts are temporarily unavailable. Please try again shortly.",
    });
  }
  const commerceControl = controlResult.value;

  if (!validStartTime) {
    return res.status(400).json({
      ok: false,
      message: "startTimeUTC must be an exact configured minute.",
    });
  }

  const cutoverGeneration = commerceControl.generation;
  const holdMutationOptions = {};

  try {
    if (clientError) throw clientError;

    let settings;
    let slotLock;
    let existingHold;
    let previousHold = null;
    let matchingBookings;
    let snapshotIncludesBarrier = false;

    if (prefetchedBatch) {
      const [batchResult, bookingsResult] = await Promise.all([
        prefetchedBatch,
        prefetchedBookings,
      ]);
      const docs = unwrapSettled(batchResult);
      matchingBookings = unwrapSettled(bookingsResult);
      const byId = new Map(docs.map((doc) => [doc?._id, doc]));
      const settingsDoc = byId.get(BOOKING_SETTINGS_ID) || null;
      slotLock = byId.get(slotLockId) || null;
      existingHold = byId.get(holdId) || null;
      previousHold = wantsPreviousHold ? byId.get(previousHoldId) || null : null;
      settings = await hydrateBookingSettings({ settingsDoc, client });
      snapshotIncludesBarrier = true;
    } else {
      const [
        settingsResult,
        slotLockResult,
        bookingsResult,
        existingHoldResult,
        previousHoldResult,
      ] = await Promise.all([
        prefetchedLegacy.settings,
        prefetchedLegacy.slotLock,
        prefetchedLegacy.bookings,
        prefetchedLegacy.existingHold,
        prefetchedLegacy.previousHold || Promise.resolve({ ok: true, value: null }),
      ]);
      settings = unwrapSettled(settingsResult);
      slotLock = unwrapSettled(slotLockResult);
      matchingBookings = unwrapSettled(bookingsResult);
      existingHold = unwrapSettled(existingHoldResult);
      previousHold = unwrapSettled(previousHoldResult);
    }

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
    if (Date.parse(normalizedStartTimeUTC) <= Date.now()) {
      return res.status(400).json({
        ok: false,
        message: "This time has already started.",
      });
    }

    const ownsPreviousHold = Boolean(
      wantsPreviousHold &&
        previousHold?._id &&
        verifyHoldToken({
          token: previousHoldToken,
          holdId: previousHoldId,
          startTimeUTC: previousHold.startTimeUTC,
          holdNonce: previousHold.holdNonce || "",
          backend: previousHold.backendOwner,
          cutoverGeneration: Number(previousHold.cutoverGeneration || 0),
        })
    );
    const previousPhase = String(previousHold?.phase || "").trim().toLowerCase();
    if (ownsPreviousHold && previousPhase === "payment_pending") {
      return res.status(409).json({
        ok: false,
        message: "The existing payment session must finish before changing slots.",
      });
    }

    let matchingBookingList = normalizeBookingList(matchingBookings);
    let activeLegacyBooking = hasBlockingBooking(matchingBookingList);
    let lockOwner = matchingBookingList.find(
      (booking) => booking?._id === slotLock?.bookingId
    );
    let staleReleasedLock = Boolean(
      slotLock &&
        slotLock.status !== "released" &&
        lockOwner?._id &&
        (!!String(lockOwner.originalOrderId || "").trim() ||
          !isBookingBlockingStatus(lockOwner.status))
    );
    if (staleReleasedLock) {
      const confirmedBookings = normalizeBookingList(
        await client.fetch(
          `*[_type == "booking" && startTimeUTC == $startTimeUTC]{_id,status,originalOrderId}`,
          { startTimeUTC: normalizedStartTimeUTC }
        )
      );
      matchingBookingList = confirmedBookings;
      activeLegacyBooking = hasBlockingBooking(matchingBookingList);
      lockOwner = matchingBookingList.find(
        (booking) => booking?._id === slotLock?.bookingId
      );
      staleReleasedLock = Boolean(
        !activeLegacyBooking &&
          slotLock &&
          slotLock.status !== "released" &&
          lockOwner?._id &&
          (!!String(lockOwner.originalOrderId || "").trim() ||
            !isBookingBlockingStatus(lockOwner.status))
      );
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
    }
    const activeLock =
      slotLock && slotLock.status !== "released" && !staleReleasedLock;
    if (activeLock || activeLegacyBooking) {
      return res.status(409).json({
        ok: false,
        message: "This slot is already booked.",
      });
    }

    if (staleReleasedLock || !snapshotIncludesBarrier) {
      let currentSlotLock;
      let currentMatchingBookings;
      if (staleReleasedLock && typeof client.getDocumentsByIds === "function") {
        const [recheckDocs, recheckBookings] = await Promise.all([
          client.getDocumentsByIds([slotLockId, holdId], {
            documentTypes: ["bookingSlot", "slotHold"],
          }),
          client.fetch(
            `*[_type == "booking" && startTimeUTC == $startTimeUTC]{_id,status,originalOrderId}`,
            { startTimeUTC: normalizedStartTimeUTC }
          ),
        ]);
        const recheckById = new Map(recheckDocs.map((doc) => [doc?._id, doc]));
        currentSlotLock = recheckById.get(slotLockId) || null;
        existingHold = recheckById.get(holdId) || null;
        currentMatchingBookings = recheckBookings;
      } else {
        if (staleReleasedLock) {
          existingHold = await client.fetch(
            `*[_type == "slotHold" && _id == $id][0]`,
            { id: holdId }
          );
        }
        [currentSlotLock, currentMatchingBookings] = await Promise.all([
          client.fetch(`*[_type == "bookingSlot" && _id == $id][0]`, {
            id: slotLockId,
          }),
          client.fetch(
            `*[_type == "booking" && startTimeUTC == $startTimeUTC]{_id,status,originalOrderId}`,
            { startTimeUTC: normalizedStartTimeUTC }
          ),
        ]);
      }
      if (
        (currentSlotLock && currentSlotLock.status !== "released") ||
        hasBlockingBooking(currentMatchingBookings)
      ) {
        return res.status(409).json({
          ok: false,
          message: "This slot is already booked.",
        });
      }
    }

    const now = Date.now();
    if (Date.parse(normalizedStartTimeUTC) <= now) {
      return res.status(400).json({
        ok: false,
        message: "This time has already started.",
      });
    }
    const expiresAt = new Date(now + HOLD_DURATION_MS).toISOString();

    if (holdOwnsSlot(existingHold, now)) {
      const mayRefresh =
        previousHoldId === holdId &&
        verifyHoldToken({
          token: previousHoldToken,
          holdId,
          startTimeUTC: existingHold.startTimeUTC || normalizedStartTimeUTC,
          holdNonce: existingHold.holdNonce || "",
          backend: existingHold.backendOwner,
          cutoverGeneration: Number(existingHold.cutoverGeneration || 0),
        });
      if (
        String(existingHold.phase || "").trim().toLowerCase() ===
        "payment_pending"
      ) {
        return res.status(409).json({
          ok: false,
          message: "This slot already has a payment session in progress.",
          ...(mayRefresh ? { code: "hold_payment_in_progress" } : {}),
        });
      }
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
            paymentFailureCount: normalizePaymentFailureCount(
              existingHold.paymentFailureCount
            ),
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
      paymentFailureCount: 0,
    };

    const shouldReleasePrevious = Boolean(
      ownsPreviousHold &&
        previousHold?._id &&
        previousHold._rev &&
        previousPhase !== "released" &&
        previousPhase !== "payment_pending"
    );
    const canBundlePreviousRelease = Boolean(
      shouldReleasePrevious &&
        typeof client.transaction === "function" &&
        (!existingHold || existingHold._rev)
    );

    const writeTargetHoldOnly = () =>
      existingHold
        ? patchAtRevision(client, existingHold, holdValues, holdMutationOptions)
        : client.create(holdValues, holdMutationOptions);

    let created;
    let releasedPreviousAtomically = false;
    let atomicReleaseFailed = false;
    try {
      if (canBundlePreviousRelease) {
        const releasedAt = new Date(now).toISOString();
        const tx = client.transaction();
        if (existingHold) {
          tx.patch(holdId, (patch) =>
            patch.ifRevisionId(existingHold._rev).set(holdValues)
          );
        } else {
          tx.create(holdValues);
        }
        tx.patch(previousHold._id, (patch) =>
          patch.ifRevisionId(previousHold._rev).set({
            phase: "released",
            releasedAt,
            expiresAt: releasedAt,
            holdNonce: crypto.randomUUID(),
          })
        );
        const knownDocuments = new Map([
          [holdId, existingHold || null],
          [previousHold._id, previousHold],
        ]);
        try {
          const committed = await tx.commit({
            ...holdMutationOptions,
            knownDocuments,
          });
          created =
            committed?.results?.find((doc) => doc?._id === holdId) || holdValues;
          releasedPreviousAtomically = true;
        } catch (error) {
          if (!isConflict(error) && !isNotFound(error)) throw error;
          atomicReleaseFailed = true;
          created = await writeTargetHoldOnly();
        }
      } else {
        created = await writeTargetHoldOnly();
      }
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
      if (shouldReleasePrevious && !releasedPreviousAtomically && !atomicReleaseFailed) {
        await releasePreviousHold({
          previousHoldId,
          previousHoldToken,
          currentHoldId: holdId,
          prefetchedHold: previousHold,
          prefetchedBackend: backend,
        });
      }
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
