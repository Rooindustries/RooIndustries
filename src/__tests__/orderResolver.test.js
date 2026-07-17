const {
  resolveBookingFromSubmittedOrderId,
} = require("../server/api/ref/orderResolver");

const createClient = (...documents) => ({
  getDocument: jest.fn(async (id) =>
    documents.find((document) => document._id === id) || null
  ),
  fetch: jest.fn(async (query, { id }) => {
    const match = query.match(
      /^\*\[_type == "([^"]+)" && ([A-Za-z][A-Za-z0-9_]*) == \$id\]\[0\]$/
    );
    if (!match) return null;

    const [, type, field] = match;
    return (
      documents.find(
        (document) => document._type === type && document[field] === id
      ) || null
    );
  }),
});

const createBooking = (overrides = {}) => ({
  _id: "booking_1",
  _type: "booking",
  email: "client@example.com",
  status: "completed",
  ...overrides,
});

describe("resolveBookingFromSubmittedOrderId", () => {
  test.each([
    ["PayPal order ID", "paypalOrderId", "PAYPAL-ORDER-1"],
    ["Razorpay order ID", "razorpayOrderId", "order_razorpay_1"],
    ["Razorpay payment ID", "razorpayPaymentId", "pay_razorpay_1"],
  ])("resolves a booking submitted by %s", async (_label, field, id) => {
    const booking = createBooking({ [field]: id });
    const client = createClient(booking);

    await expect(
      resolveBookingFromSubmittedOrderId({ id, client })
    ).resolves.toBe(booking);

    expect(client.getDocument).toHaveBeenCalledWith(id);
    expect(client.fetch).toHaveBeenCalledWith(
      `*[_type == "booking" && ${field} == $id][0]`,
      { id }
    );
  });

  test.each([
    [
      "PayPal provider order ID",
      "paypal",
      { providerOrderId: "PAYPAL-ORDER-2" },
      "paypalOrderId",
      "PAYPAL-ORDER-2",
    ],
    [
      "Razorpay provider order ID",
      "razorpay",
      { providerOrderId: "order_razorpay_2" },
      "razorpayOrderId",
      "order_razorpay_2",
    ],
    [
      "Razorpay provider payment ID",
      "razorpay",
      { providerPaymentId: "pay_razorpay_2" },
      "razorpayPaymentId",
      "pay_razorpay_2",
    ],
  ])(
    "resolves a payment record through its %s",
    async (_label, provider, recordIds, bookingField, bookingValue) => {
      const booking = createBooking({ [bookingField]: bookingValue });
      const paymentRecord = {
        _id: `payment_record_${provider}_${bookingField}`,
        _type: "paymentRecord",
        provider,
        ...recordIds,
      };
      const client = createClient(booking, paymentRecord);

      await expect(
        resolveBookingFromSubmittedOrderId({
          id: paymentRecord._id,
          client,
        })
      ).resolves.toBe(booking);

      expect(client.fetch).toHaveBeenCalledWith(
        `*[_type == "booking" && ${bookingField} == $id][0]`,
        { id: bookingValue }
      );
    }
  );
});
