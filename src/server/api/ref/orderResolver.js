const cleanId = (value) => String(value || "").trim();

const GENERIC_ID_PREFIX =
  /^(?:(?:booking|order|pay|cks|paymentrecord|session)[._-]+)+/i;
const MIN_PARTIAL_ID_LENGTH = 8;

const identifierCore = (value) =>
  String(value || "").toLowerCase().replace(GENERIC_ID_PREFIX, "");

export const BOOKING_IDENTIFIER_FIELDS = [
  "orderId",
  "dodoCheckoutSessionId",
  "dodoPaymentId",
  "paypalOrderId",
  "razorpayOrderId",
  "razorpayPaymentId",
];

export const normalizeSubmittedOrderId = (value) => {
  let id = cleanId(value);
  id = id.replace(
    /^(?:your\s+)?(?:order|booking|payment|transaction)?\s*(?:id|number|no\.?)?\s*[:#]\s*/i,
    ""
  );
  id = id.replace(/^order\s+id\s+/i, "");
  id = id.replace(/^["'`\[\(<{]+|["'`\]\)>}]+$/g, "");
  id = id.replace(/\s+/g, "");
  id = id.replace(/[.,;:]+$/, "");
  return id;
};

export const bookingIdentifierValues = (booking) =>
  ["_id", ...BOOKING_IDENTIFIER_FIELDS]
    .map((field) => cleanId(booking?.[field]).replace(/\s+/g, "").toLowerCase())
    .filter(Boolean);

export const submittedOrderIdMatchesBooking = (submitted, booking) => {
  const needle = normalizeSubmittedOrderId(submitted).toLowerCase();
  const core = identifierCore(needle);
  if (core.length < MIN_PARTIAL_ID_LENGTH) return false;
  return bookingIdentifierValues(booking).some((value) => {
    const valueCore = identifierCore(value);
    return (
      value === needle ||
      valueCore === core ||
      valueCore.includes(core) ||
      (valueCore.length >= MIN_PARTIAL_ID_LENGTH && core.includes(valueCore))
    );
  });
};

export const isBookingDocument = (doc) => doc?._type === "booking" && !!doc?._id;

const isPaymentRecordDocument = (doc) =>
  doc?._type === "paymentRecord" && !!doc?._id;

const fetchBookingByField = async ({ client, field, id }) => {
  if (!id) return null;
  return client.fetch(`*[_type == "booking" && ${field} == $id][0]`, { id });
};

const fetchBookingByFieldInsensitive = async ({ client, field, id }) => {
  if (!id) return null;
  return client.fetch(`*[_type == "booking" && lower(${field}) == $id][0]`, {
    id: String(id).toLowerCase(),
  });
};

const fetchPaymentRecordByFieldInsensitive = async ({ client, field, id }) => {
  if (!id) return null;
  return client.fetch(
    `*[_type == "paymentRecord" && lower(${field}) == $id][0]`,
    { id: String(id).toLowerCase() }
  );
};

const fetchPaymentRecordByField = async ({ client, field, id }) => {
  if (!id) return null;
  return client.fetch(`*[_type == "paymentRecord" && ${field} == $id][0]`, {
    id,
  });
};

const resolveBookingFromPaymentRecord = async ({ record, client }) => {
  if (!isPaymentRecordDocument(record)) return null;

  const bookingId = cleanId(record.bookingId);
  if (bookingId) {
    const booking = await fetchBookingByField({
      client,
      field: "_id",
      id: bookingId,
    });
    if (isBookingDocument(booking)) return booking;
  }

  const provider = String(record.provider || "").trim().toLowerCase();
  const providerOrderId = cleanId(record.providerOrderId);
  const providerPaymentId = cleanId(record.providerPaymentId);

  if (provider === "dodo" && (providerPaymentId || providerOrderId)) {
    const booking = await fetchBookingByField({ client, field: providerPaymentId ? "dodoPaymentId" : "dodoCheckoutSessionId", id: providerPaymentId || providerOrderId });
    if (isBookingDocument(booking)) return booking;
  }
  if (provider === "paypal" && providerOrderId) {
    const booking = await fetchBookingByField({
      client,
      field: "paypalOrderId",
      id: providerOrderId,
    });
    if (isBookingDocument(booking)) return booking;
  }

  if (provider === "razorpay" && providerPaymentId) {
    const booking = await fetchBookingByField({
      client,
      field: "razorpayPaymentId",
      id: providerPaymentId,
    });
    if (isBookingDocument(booking)) return booking;
  }

  if (provider === "razorpay" && providerOrderId) {
    const booking = await fetchBookingByField({
      client,
      field: "razorpayOrderId",
      id: providerOrderId,
    });
    if (isBookingDocument(booking)) return booking;
  }

  return null;
};

export const resolveBookingFromSubmittedOrderId = async ({ id, client }) => {
  const normalizedId = normalizeSubmittedOrderId(id);
  if (!normalizedId || !client) return null;

  const directDocument = await client.getDocument(normalizedId);
  if (isBookingDocument(directDocument)) return directDocument;

  for (const field of BOOKING_IDENTIFIER_FIELDS) {
    const booking = await fetchBookingByField({
      client,
      field,
      id: normalizedId,
    });
    if (isBookingDocument(booking)) return booking;
  }

  for (const field of [
    "_id",
    "providerOrderId",
    "providerPaymentId",
    "bookingId",
  ]) {
    const directPaymentRecord =
      field === "_id" && isPaymentRecordDocument(directDocument)
        ? directDocument
        : null;
    const record =
      directPaymentRecord ||
      (await fetchPaymentRecordByField({
        client,
        field,
        id: normalizedId,
      }));
    const booking = await resolveBookingFromPaymentRecord({ record, client });
    if (isBookingDocument(booking)) return booking;
  }

  const loweredId = normalizedId.toLowerCase();
  if (loweredId !== normalizedId) {
    const loweredDocument = await client.getDocument(loweredId);
    if (isBookingDocument(loweredDocument)) return loweredDocument;
  }

  for (const field of BOOKING_IDENTIFIER_FIELDS) {
    const booking = await fetchBookingByFieldInsensitive({
      client,
      field,
      id: normalizedId,
    });
    if (isBookingDocument(booking)) return booking;
  }

  for (const field of ["providerOrderId", "providerPaymentId"]) {
    const record = await fetchPaymentRecordByFieldInsensitive({
      client,
      field,
      id: normalizedId,
    });
    const booking = await resolveBookingFromPaymentRecord({ record, client });
    if (isBookingDocument(booking)) return booking;
  }

  return null;
};
