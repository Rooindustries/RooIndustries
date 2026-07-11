import {
  claimEmailDispatchPair,
  completeEmailDispatch,
  listEmailDispatchRecoveryBookingIds,
} from "../server/supabase/emailDispatchLedger";

const createClient = () => {
  const shadowClient = {
    rpc: jest.fn(async (name, parameters) => {
      if (name === "roo_claim_booking_email_dispatch") {
        return {
          data: {
            claimed: true,
            sent: false,
            in_progress: false,
            idempotency_key: `booking.one-${parameters.p_recipient_type}`,
          },
          error: null,
        };
      }
      if (name === "roo_complete_booking_email_dispatch") {
        return {
          data: {
            completed: true,
            sent: parameters.p_success,
            provider_message_id: parameters.p_provider_message_id,
            sent_at: parameters.p_sent_at,
          },
          error: null,
        };
      }
      if (name === "roo_list_email_dispatch_recovery_bookings") {
        return { data: ["booking.one"], error: null };
      }
      return { data: null, error: { code: "UNKNOWN_RPC" } };
    }),
  };
  return { backend: "supabase", shadowClient };
};

describe("authoritative Supabase email dispatch ledger", () => {
  test("claims customer and owner rows with one stable group lease", async () => {
    const client = createClient();
    await expect(
      claimEmailDispatchPair({
        client,
        bookingId: "booking.one",
        dispatchKind: "booking_confirmation",
        leaseId: "lease-12345678",
      })
    ).resolves.toEqual({
      customer: expect.objectContaining({
        claimed: true,
        idempotencyKey: "booking.one-customer",
      }),
      owner: expect.objectContaining({
        claimed: true,
        idempotencyKey: "booking.one-owner",
      }),
    });
    expect(client.shadowClient.rpc).toHaveBeenCalledTimes(2);
  });

  test("records the provider result using the ledger idempotency key", async () => {
    const client = createClient();
    const sentAt = "2026-07-12T01:00:00.000Z";
    await completeEmailDispatch({
      client,
      dispatch: { idempotencyKey: "booking.one-customer" },
      leaseId: "lease-12345678",
      success: true,
      providerMessageId: "resend-message-one",
      sentAt,
    });
    expect(client.shadowClient.rpc).toHaveBeenCalledWith(
      "roo_complete_booking_email_dispatch",
      expect.objectContaining({
        p_idempotency_key: "booking.one-customer",
        p_lease_id: "lease-12345678",
        p_success: true,
        p_provider_message_id: "resend-message-one",
        p_sent_at: sentAt,
      })
    );
  });

  test("lists typed-ledger retries without using the compatibility query", async () => {
    const client = createClient();
    await expect(
      listEmailDispatchRecoveryBookingIds({
        client,
        dispatchKind: "booking_confirmation",
      })
    ).resolves.toEqual(["booking.one"]);
  });

  test("does not touch Supabase for a Sanity-owned booking", async () => {
    await expect(
      claimEmailDispatchPair({
        client: { backend: "sanity" },
        bookingId: "booking.one",
        dispatchKind: "booking_confirmation",
        leaseId: "lease-12345678",
      })
    ).resolves.toBeNull();
  });
});
