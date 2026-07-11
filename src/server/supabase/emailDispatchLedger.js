const normalizeDispatch = (value = {}) => ({
  claimed: value?.claimed === true,
  sent: value?.sent === true,
  historicalUnknown: value?.historical_unknown === true,
  inProgress: value?.in_progress === true,
  idempotencyKey: String(value?.idempotency_key || "").trim(),
  providerMessageId: String(value?.provider_message_id || "").trim(),
  sentAt: String(value?.sent_at || "").trim(),
});

const requireRpc = async ({ client, name, parameters }) => {
  const { data, error } = await client.rpc(name, parameters);
  if (!error) return data;
  const failure = new Error(`Supabase ${name} failed.`);
  failure.code = error.code || "SUPABASE_EMAIL_LEDGER_FAILED";
  failure.statusCode = Number(error.status || 0) || 503;
  failure.status = failure.statusCode;
  throw failure;
};

export const hasAuthoritativeEmailLedger = (client) =>
  client?.backend === "supabase" && !!client?.shadowClient?.rpc;

export const claimEmailDispatchPair = async ({
  client,
  bookingId,
  dispatchKind,
  leaseId,
} = {}) => {
  if (!hasAuthoritativeEmailLedger(client)) return null;
  const target = client.shadowClient;
  const [customer, owner] = await Promise.all(
    ["customer", "owner"].map((recipientType) =>
      requireRpc({
        client: target,
        name: "roo_claim_booking_email_dispatch",
        parameters: {
          p_booking_legacy_id: String(bookingId || "").trim(),
          p_dispatch_kind: String(dispatchKind || "").trim(),
          p_recipient_type: recipientType,
          p_lease_id: String(leaseId || "").trim(),
          p_lease_seconds: 120,
        },
      })
    )
  );
  return {
    customer: normalizeDispatch(customer),
    owner: normalizeDispatch(owner),
  };
};

export const completeEmailDispatch = async ({
  client,
  dispatch,
  leaseId,
  success,
  providerMessageId = "",
  errorCode = "",
  sentAt = new Date().toISOString(),
  nextAttemptAt = null,
} = {}) => {
  if (!dispatch?.idempotencyKey || !hasAuthoritativeEmailLedger(client)) {
    return null;
  }
  const data = await requireRpc({
    client: client.shadowClient,
    name: "roo_complete_booking_email_dispatch",
    parameters: {
      p_idempotency_key: dispatch.idempotencyKey,
      p_lease_id: String(leaseId || "").trim(),
      p_success: success === true,
      p_provider_message_id: String(providerMessageId || "").trim() || null,
      p_error_code: String(errorCode || "").trim() || null,
      p_sent_at: success ? sentAt : null,
      p_next_attempt_at: success ? null : nextAttemptAt,
    },
  });
  return normalizeDispatch({
    ...data,
    claimed: false,
    in_progress: false,
  });
};

export const listEmailDispatchRecoveryBookingIds = async ({
  client,
  dispatchKind,
  now = new Date().toISOString(),
  limit = 20,
} = {}) => {
  if (!hasAuthoritativeEmailLedger(client)) return null;
  const data = await requireRpc({
    client: client.shadowClient,
    name: "roo_list_email_dispatch_recovery_bookings",
    parameters: {
      p_dispatch_kind: String(dispatchKind || "").trim(),
      p_now: now,
      p_limit: Math.max(1, Math.min(100, Number(limit) || 20)),
    },
  });
  return Array.isArray(data) ? data.map(String).filter(Boolean) : [];
};
