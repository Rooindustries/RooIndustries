import {
  buildReferralEmailIdempotencyKey,
  deliverReferralEmailDispatch,
  enqueueReferralEmailMutation,
  requeueReferralEmailDispatch,
  reconcileReferralEmailDispatches,
} from "../server/api/ref/referralEmailDispatches";

const email = "creator@example.com";
const token = "a".repeat(64);
const idempotencyKey = buildReferralEmailIdempotencyKey({
  dispatchKind: "password_reset",
  referralId: "referral.creator",
  recipientEmail: email,
  token,
});

const claimedDispatch = (attemptCount = 1) => ({
  claimed: true,
  idempotency_key: idempotencyKey,
  dispatch_kind: "password_reset",
  recipient_email: email,
  delivery_payload: { token, name: "Creator" },
  attempt_count: attemptCount,
});

describe("referral email dispatch worker", () => {
  test("derives stable provider keys from normalized command inputs", () => {
    expect(
      buildReferralEmailIdempotencyKey({
        dispatchKind: "password_reset",
        referralId: "referral.creator",
        recipientEmail: " CREATOR@example.com ",
        token,
      })
    ).toBe(idempotencyKey);
    expect(idempotencyKey).toMatch(/^referral-email-[0-9a-f]{64}$/);
  });

  test("passes hashed recipients and tokens to the atomic enqueue RPC", async () => {
    const rpc = jest.fn(async () => ({
      data: { idempotency_key: idempotencyKey, status: "pending" },
      error: null,
    }));
    const result = await enqueueReferralEmailMutation({
      mutations: [{ operation: "replace", document: { _id: "referral.creator" } }],
      referralId: "referral.creator",
      dispatchKind: "password_reset",
      recipientEmail: email,
      token,
      name: "Creator",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      adminClient: { rpc },
    });

    expect(result.status).toBe("pending");
    expect(rpc).toHaveBeenCalledWith(
      "roo_enqueue_referral_email_mutation",
      expect.objectContaining({
        p_recipient_email: email,
        p_recipient_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        p_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        p_delivery_payload: { token, name: "Creator" },
      })
    );
  });

  test("uses the audited recovery RPC for a terminal dispatch", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        status: "retry",
        requeued: true,
        sent: false,
        dead_letter: false,
      },
      error: null,
    }));

    await expect(requeueReferralEmailDispatch({
      referralId: "referral.creator",
      dispatchKind: "password_reset",
      adminClient: { rpc },
    })).resolves.toMatchObject({ status: "retry", requeued: true });
    expect(rpc).toHaveBeenCalledWith("roo_requeue_referral_email_dispatch", {
      p_referral_id: "referral.creator",
      p_dispatch_kind: "password_reset",
    });
  });

  test("retries an accepted timeout with the exact same provider idempotency key", async () => {
    const completions = [];
    let claims = 0;
    const rpc = jest.fn(async (name, params) => {
      if (name === "roo_claim_referral_email_dispatch") {
        claims += 1;
        return { data: claimedDispatch(claims), error: null };
      }
      if (name === "roo_complete_referral_email_dispatch") {
        completions.push(params);
        return {
          data: {
            status: params.p_success ? "sent" : "retry",
            sent: params.p_success,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const accepted = new Map();
    const providerKeys = [];
    let firstResponse = true;
    const resendClient = {
      emails: {
        send: jest.fn(async (_message, options) => {
          providerKeys.push(options.idempotencyKey);
          if (!accepted.has(options.idempotencyKey)) {
            accepted.set(options.idempotencyKey, "provider-message-1");
          }
          if (firstResponse) {
            firstResponse = false;
            const error = new Error("response timed out");
            error.code = "provider_timeout";
            throw error;
          }
          return {
            data: { id: accepted.get(options.idempotencyKey) },
            error: null,
          };
        }),
      },
    };

    const first = await deliverReferralEmailDispatch({
      idempotencyKey,
      adminClient: { rpc },
      resendClient,
    });
    const second = await deliverReferralEmailDispatch({
      idempotencyKey,
      adminClient: { rpc },
      resendClient,
    });

    expect(first.retry).toBe(1);
    expect(second.sent).toBe(1);
    expect(providerKeys).toEqual([idempotencyKey, idempotencyKey]);
    expect(accepted.size).toBe(1);
    expect(completions.map((entry) => entry.p_success)).toEqual([false, true]);
  });

  test("continues a leased batch after one provider failure", async () => {
    const firstKey = idempotencyKey;
    const secondKey = buildReferralEmailIdempotencyKey({
      dispatchKind: "registration_verification",
      referralId: "referral.second",
      recipientEmail: "second@example.com",
      token: "b".repeat(43),
    });
    const rpc = jest.fn(async (name, params) => {
      if (name === "roo_claim_referral_email_dispatches") {
        return {
          data: [
            claimedDispatch(1),
            {
              ...claimedDispatch(1),
              idempotency_key: secondKey,
              dispatch_kind: "registration_verification",
              recipient_email: "second@example.com",
              delivery_payload: { token: "b".repeat(43), name: "Second" },
            },
          ],
          error: null,
        };
      }
      if (name === "roo_complete_referral_email_dispatch") {
        return {
          data: {
            status:
              params.p_idempotency_key === firstKey ? "retry" : "sent",
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const resendClient = {
      emails: {
        send: jest.fn(async (_message, options) => {
          if (options.idempotencyKey === firstKey) {
            const error = new Error("temporary failure");
            error.code = "provider_unavailable";
            throw error;
          }
          return { data: { id: "provider-message-2" }, error: null };
        }),
      },
    };

    const result = await reconcileReferralEmailDispatches({
      limit: 100,
      adminClient: { rpc },
      resendClient,
    });

    expect(result).toEqual({ claimed: 2, sent: 1, retry: 1, deadLetter: 0 });
    expect(resendClient.emails.send).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith(
      "roo_claim_referral_email_dispatches",
      expect.objectContaining({ p_limit: 10, p_lease_seconds: 300 }),
    );
  });
});
