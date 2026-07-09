import crypto from "crypto";

export const COUPON_REDEMPTION_TYPE = "couponRedemption";
export const COUPON_REDEMPTION_STATUS = Object.freeze({
  RESERVED: "reserved",
  CONSUMED: "consumed",
  RELEASED: "released",
  REFUNDED: "refunded",
});

const normalize = (value) => String(value || "").trim();
export const normalizeCouponCode = (value) => normalize(value).toLowerCase();

export const buildCouponRedemptionId = ({ couponId, ownerId }) => {
  const seed = `${normalize(couponId)}:${normalize(ownerId)}`;
  if (seed === ":") return "";
  const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `couponRedemption.${digest}`;
};

const conflict = (message) => {
  const error = new Error(message);
  error.status = 409;
  error.code = "coupon_reservation_conflict";
  return error;
};

const patchRevision = (transaction, document, mutate) =>
  transaction.patch(document._id, (patch) => {
    const guarded = document._rev ? patch.ifRevisionId(document._rev) : patch;
    return mutate(guarded);
  });

const fetchCoupon = async ({ client, couponCode }) =>
  client.fetch(
    `*[_type == "coupon" && lower(code) == $code][0]{
      _id,_rev,code,isActive,timesUsed,activeReservations,maxUses
    }`,
    { code: normalizeCouponCode(couponCode) }
  );

export const prepareCouponReservation = async ({
  client,
  couponCode,
  ownerId,
  expiresAt = "",
  bookingId = "",
  paymentRecordId = "",
}) => {
  const code = normalizeCouponCode(couponCode);
  const normalizedOwnerId = normalize(ownerId);
  if (!code) return null;
  if (!client || !normalizedOwnerId) {
    throw new Error("Coupon reservation requires a client and stable ownerId.");
  }

  const coupon = await fetchCoupon({ client, couponCode: code });
  if (!coupon?._id || coupon.isActive === false) {
    throw conflict("Coupon not found or inactive.");
  }
  const redemptionId = buildCouponRedemptionId({
    couponId: coupon._id,
    ownerId: normalizedOwnerId,
  });
  const existing = await client.fetch(
    `*[_type == $type && _id == $id][0]`,
    { type: COUPON_REDEMPTION_TYPE, id: redemptionId }
  );
  if (
    existing?.status === COUPON_REDEMPTION_STATUS.RESERVED ||
    existing?.status === COUPON_REDEMPTION_STATUS.CONSUMED
  ) {
    return { coupon, redemption: existing, idempotent: true };
  }

  const used = Number(coupon.timesUsed || 0);
  const reserved = Number(coupon.activeReservations || 0);
  const maxUses = Number(coupon.maxUses || 0);
  if (maxUses > 0 && used + reserved >= maxUses) {
    throw conflict("This coupon has reached its maximum number of uses.");
  }

  const now = new Date().toISOString();
  const redemption = {
    ...(existing?._id ? existing : {}),
    _id: redemptionId,
    _type: COUPON_REDEMPTION_TYPE,
    coupon: { _type: "reference", _ref: coupon._id },
    couponCode: code,
    ownerId: normalizedOwnerId,
    bookingId: normalize(bookingId),
    paymentRecordId: normalize(paymentRecordId),
    status: COUPON_REDEMPTION_STATUS.RESERVED,
    reservedAt: now,
    ...(normalize(expiresAt) ? { expiresAt: normalize(expiresAt) } : {}),
  };
  return { coupon, redemption, idempotent: false };
};

export const appendCouponReservation = (input, prepared = null) => {
  const {
    transaction,
    coupon,
    redemption,
    idempotent = false,
  } = prepared
    ? { transaction: input, ...prepared }
    : input || {};
  if (!transaction || !coupon?._id || !redemption?._id || idempotent) {
    return transaction;
  }
  const used = Number(coupon.timesUsed || 0);
  if (redemption._rev) {
    const redemptionSet = { ...redemption };
    delete redemptionSet._id;
    delete redemptionSet._rev;
    delete redemptionSet._createdAt;
    delete redemptionSet._updatedAt;
    patchRevision(transaction, redemption, (patch) => patch.set(redemptionSet));
  } else {
    transaction.create(redemption);
  }
  patchRevision(transaction, coupon, (patch) =>
    patch.setIfMissing({ activeReservations: 0, timesUsed: used }).inc({
      activeReservations: 1,
    })
  );
  return transaction;
};

export const reserveCouponUse = async (input) => {
  const prepared = await prepareCouponReservation(input);
  if (!prepared || prepared.idempotent) return prepared;
  const { client } = input;
  const { coupon, redemption } = prepared;
  const transaction = client.transaction();
  appendCouponReservation({ transaction, coupon, redemption });
  try {
    await transaction.commit();
  } catch (error) {
    if (Number(error?.statusCode || error?.status || 0) === 409) {
      throw conflict("Coupon availability changed. Please refresh the quote.");
    }
    throw error;
  }
  const [freshCoupon, freshRedemption] = await Promise.all([
    client.fetch(`*[_type == "coupon" && _id == $id][0]{...}`, {
      id: coupon._id,
    }),
    client.fetch(`*[_type == $type && _id == $id][0]{...}`, {
      type: COUPON_REDEMPTION_TYPE,
      id: redemption._id,
    }),
  ]);
  return {
    coupon: freshCoupon || coupon,
    redemption: freshRedemption || redemption,
    idempotent: false,
  };
};

export const appendCouponConsumption = ({
  transaction,
  coupon,
  redemption,
  bookingId,
  consumedAt = new Date().toISOString(),
}) => {
  if (!redemption?._id) return transaction;
  if (redemption.status === COUPON_REDEMPTION_STATUS.CONSUMED) return transaction;
  if (redemption.status !== COUPON_REDEMPTION_STATUS.RESERVED || !coupon?._id) {
    throw conflict("Coupon reservation is no longer available.");
  }

  const used = Number(coupon.timesUsed || 0);
  const maxUses = Number(coupon.maxUses || 0);
  const deactivatesCoupon = maxUses > 0 && used + 1 >= maxUses;
  patchRevision(transaction, redemption, (patch) =>
    patch.set({
      status: COUPON_REDEMPTION_STATUS.CONSUMED,
      bookingId: normalize(bookingId),
      consumedAt,
      releasedAt: "",
      deactivatedCouponAtConsume: deactivatesCoupon,
    })
  );
  patchRevision(transaction, coupon, (patch) => {
    const next = patch
      .setIfMissing({ activeReservations: 0, timesUsed: used })
      .dec({ activeReservations: 1 })
      .inc({ timesUsed: 1 });
    return deactivatesCoupon ? next.set({ isActive: false }) : next;
  });
  return transaction;
};

export const consumeCouponReservation = async ({
  client,
  redemptionId,
  bookingId,
}) => {
  const redemption = await client.fetch(
    `*[_type == $type && _id == $id][0]{...}`,
    { type: COUPON_REDEMPTION_TYPE, id: redemptionId }
  );
  if (!redemption?._id) throw conflict("Coupon reservation was not found.");
  if (redemption.status === COUPON_REDEMPTION_STATUS.CONSUMED) {
    return { redemption, idempotent: true };
  }
  const coupon = await client.fetch(`*[_type == "coupon" && _id == $id][0]{...}`, {
    id: redemption.coupon?._ref,
  });
  const transaction = client.transaction();
  appendCouponConsumption({ transaction, coupon, redemption, bookingId });
  await transaction.commit();
  return { redemption: { ...redemption, status: "consumed", bookingId }, idempotent: false };
};

export const releaseCouponReservation = async ({
  client,
  redemptionId,
  reason = "abandoned",
}) => {
  const redemption = await client.fetch(
    `*[_type == $type && _id == $id][0]{...}`,
    { type: COUPON_REDEMPTION_TYPE, id: redemptionId }
  );
  if (!redemption?._id || redemption.status !== COUPON_REDEMPTION_STATUS.RESERVED) {
    return { released: false, idempotent: true };
  }
  const coupon = await client.fetch(`*[_type == "coupon" && _id == $id][0]{...}`, {
    id: redemption.coupon?._ref,
  });
  const releasedAt = new Date().toISOString();
  const transaction = client.transaction();
  patchRevision(transaction, redemption, (patch) =>
    patch.set({ status: "released", releasedAt, releaseReason: normalize(reason) })
  );
  if (coupon?._id) {
    patchRevision(transaction, coupon, (patch) => {
      const activeReservations = Number(coupon.activeReservations || 0);
      return activeReservations > 0
        ? patch.dec({ activeReservations: 1 })
        : patch.setIfMissing({ activeReservations: 0 });
    });
  }
  await transaction.commit();
  return { released: true, idempotent: false };
};

export const appendCouponRefund = ({
  transaction,
  coupon,
  redemption,
  refundedAt = new Date().toISOString(),
}) => {
  if (
    !redemption?._id ||
    redemption.status === COUPON_REDEMPTION_STATUS.REFUNDED ||
    redemption.status !== COUPON_REDEMPTION_STATUS.CONSUMED
  ) {
    return transaction;
  }
  patchRevision(transaction, redemption, (patch) =>
    patch.set({ status: COUPON_REDEMPTION_STATUS.REFUNDED, refundedAt })
  );
  if (coupon?._id) {
    const used = Math.max(0, Number(coupon.timesUsed || 0));
    patchRevision(transaction, coupon, (patch) => {
      const next = used > 0 ? patch.dec({ timesUsed: 1 }) : patch;
      return redemption.deactivatedCouponAtConsume === true
        ? next.set({ isActive: true })
        : next;
    });
  }
  return transaction;
};

export const restoreCouponAfterRefund = async ({ client, redemptionId }) => {
  const redemption = await client.fetch(
    `*[_type == $type && _id == $id][0]{...}`,
    { type: COUPON_REDEMPTION_TYPE, id: redemptionId }
  );
  if (!redemption?._id || redemption.status === COUPON_REDEMPTION_STATUS.REFUNDED) {
    return { restored: false, idempotent: true };
  }
  const coupon = await client.fetch(`*[_type == "coupon" && _id == $id][0]{...}`, {
    id: redemption.coupon?._ref,
  });
  const transaction = client.transaction();
  appendCouponRefund({ transaction, coupon, redemption });
  await transaction.commit();
  return { restored: true, idempotent: false };
};
