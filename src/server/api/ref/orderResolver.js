const normalizeSubmittedOrderId = (value) => String(value || "").trim();

export const isBookingDocument = (doc) => doc?._type === "booking" && !!doc?._id;

const isPaymentRecordDocument = (doc) =>
  doc?._type === "paymentRecord" && !!doc?._id;

const fetchBookingByField = async ({ client, field, id }) => {
  if (!id) return null;
  return client.fetch(`*[_type == "booking" && ${field} == $id][0]`, { id });
};

const fetchPaymentRecordByField = async ({ client, field, id }) => {
  if (!id) return null;
  return client.fetch(`*[_type == "paymentRecord" && ${field} == $id][0]`, {
    id,
  });
};

const resolveBookingFromPaymentRecord = async ({ record, client }) => {
  if (!isPaymentRecordDocument(record)) return null;

  const bookingId = normalizeSubmittedOrderId(record.bookingId);
  if (bookingId) {
    const booking = await fetchBookingByField({
      client,
      field: "_id",
      id: bookingId,
    });
    if (isBookingDocument(booking)) return booking;
  }

  const provider = String(record.provider || "").trim().toLowerCase();
  const providerOrderId = normalizeSubmittedOrderId(record.providerOrderId);
  const providerPaymentId = normalizeSubmittedOrderId(record.providerPaymentId);

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

  for (const field of [
    "orderId",
    "paypalOrderId",
    "razorpayOrderId",
    "razorpayPaymentId",
  ]) {
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

  return null;
};
