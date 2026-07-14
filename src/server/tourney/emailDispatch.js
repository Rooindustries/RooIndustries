import crypto from "node:crypto";
import {
  sendTourneyAppealAdminEmail,
  sendTourneyAppealConfirmationEmail,
  sendTourneyDiscordInviteEmail,
  sendTourneyPayoutNotificationEmail,
  sendTourneyPlayerApprovedEmail,
  sendTourneyRegistrationApprovalEmails,
  sendTourneyResetEmail,
} from "./email.js";
import { getTourneySql, runTourneyTransaction } from "./sqlClient.js";
import { resolveTourneyStorePolicy } from "./store.js";
import { stableTourneyJson } from "./canonical.js";
import { runAuditedTourneyQueueRepair } from "./externalOperations.js";

const normalize = (value) => String(value || "").trim();
const recipientHash = (value) =>
  crypto
    .createHash("sha256")
    .update(normalize(value).toLowerCase())
    .digest("hex");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const dispatchTable = (backend) =>
  backend === "supabase" ? "tourney.email_dispatches" : "tourney_email_dispatches";

const reconciliationDeadlineError = () => Object.assign(
  new Error("Tournament reconciliation exceeded its runtime budget."),
  { code: "TOURNEY_RECONCILIATION_DEADLINE_EXCEEDED", status: 503 }
);

const assertBeforeDeadline = (deadlineAt) => {
  const deadline = Number(deadlineAt);
  if (Number.isFinite(deadline) && Date.now() >= deadline) {
    throw reconciliationDeadlineError();
  }
};

export const isExpiredTourneyResetDispatch = (
  dispatch,
  now = Date.now()
) => {
  if (dispatch?.dispatch_kind !== "reset") return false;
  const expiresAt = Date.parse(String(dispatch?.payload?.expiresAt || ""));
  return !Number.isFinite(expiresAt) || expiresAt <= Number(now);
};

export const buildTourneyEmailIdempotencyKey = ({
  audience,
  commandId,
  dispatchKind,
  entityId,
  entityType,
  entityVersion,
  recipient,
  semanticKey = "",
} = {}) => `tourney-v1:${sha256(stableTourneyJson({
  audience: normalize(audience),
  commandId: normalize(commandId),
  dispatchKind: normalize(dispatchKind),
  entityId: normalize(entityId),
  entityType: normalize(entityType),
  entityVersion: normalize(entityVersion),
  recipientHash: recipientHash(recipient),
  semanticKey: normalize(semanticKey),
}))}`;

const MEMORY_DISPATCHES =
  globalThis.__rooTourneyEmailDispatches ||
  (globalThis.__rooTourneyEmailDispatches = new Map());

const setEmailMirrorContext = async ({ sql, policy, commandId }) => {
  await sql`
    select
      set_config('roo.tourney_backend', ${policy.primaryBackend}, true),
      set_config('roo.tourney_mirror_enabled', ${policy.mirrorEnabled ? "1" : "0"}, true),
      set_config('roo.tourney_generation', ${String(policy.generation)}, true),
      set_config('roo.tourney_command_id', ${commandId}, true)
  `;
};

export const enqueueTourneyEmailDispatch = async ({
  commandId,
  dispatchKind,
  recipient,
  payload,
  idempotencyKey = "",
  entityType = "",
  entityId = "",
  entityVersion = "",
  audience = "",
  historical = false,
  env = process.env,
} = {}) => {
  const normalizedRecipient = normalize(recipient);
  if (!normalizedRecipient) throw new Error("A Tourney email recipient is required.");
  const policy = resolveTourneyStorePolicy(env);
  const table = dispatchTable(policy.primaryBackend);
  const inferredEntityId = normalize(
    entityId || payload?.player?.id || payload?.appeal?.id || payload?.payout?.id ||
    payload?.tokenHash || "global"
  );
  const inferredVersion = normalize(
    entityVersion || payload?.player?.version || payload?.appeal?.updatedAt ||
    payload?.payout?.updatedAt || payload?.transition || "1"
  );
  const inferredAudience = normalize(audience || payload?.audience || "recipient");
  const key = buildTourneyEmailIdempotencyKey({
    audience: inferredAudience,
    commandId,
    dispatchKind,
    entityId: inferredEntityId,
    entityType: entityType || dispatchKind,
    entityVersion: inferredVersion,
    recipient: normalizedRecipient,
    semanticKey: idempotencyKey,
  });
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    const dispatch = MEMORY_DISPATCHES.get(key) || {
      id: crypto.randomUUID(),
      idempotency_key: key,
      status: historical ? "historical_unknown" : "pending",
    };
    MEMORY_DISPATCHES.set(key, dispatch);
    return dispatch;
  }
  const sql = await getTourneySql(env);
  const rows = await sql`
    insert into ${sql(table)} (
      idempotency_key, command_id, dispatch_kind, recipient,
      recipient_hash, payload, status
    ) values (
      ${key}, ${normalize(commandId) || null}, ${normalize(dispatchKind)},
      ${normalizedRecipient}, ${recipientHash(normalizedRecipient)},
      ${sql.json(payload || {})}, ${historical ? "historical_unknown" : "pending"}
    )
    on conflict (idempotency_key) do update
    set updated_at = now()
    returning id, idempotency_key, status
  `;
  return rows[0];
};

const sendDispatch = ({ dispatch, env, signal }) => {
  if (isExpiredTourneyResetDispatch(dispatch)) {
    const error = new Error("The Tourney reset link expired before dispatch.");
    error.code = "TOURNEY_RESET_DISPATCH_EXPIRED";
    throw error;
  }

  const payload = dispatch.payload || {};
  const common = {
    ...payload,
    env,
    idempotencyKey: dispatch.idempotency_key,
    signal,
  };
  switch (dispatch.dispatch_kind) {
    case "registration":
      return sendTourneyRegistrationApprovalEmails(common);
    case "approval":
      return sendTourneyPlayerApprovedEmail(common);
    case "reset":
      return sendTourneyResetEmail(common);
    case "discord_invite":
      return sendTourneyDiscordInviteEmail(common);
    case "appeal":
      return payload.audience === "admin"
        ? sendTourneyAppealAdminEmail(common)
        : sendTourneyAppealConfirmationEmail(common);
    case "payout":
      return sendTourneyPayoutNotificationEmail(common);
    default:
      throw new Error("Unsupported Tourney email dispatch.");
  }
};

const sendBeforeDeadline = async ({ dispatch, env, deadlineAt }) => {
  assertBeforeDeadline(deadlineAt);
  const deadline = Number(deadlineAt);
  if (!Number.isFinite(deadline)) return sendDispatch({ dispatch, env });
  const remainingMs = Math.max(1, deadline - Date.now());
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => sendDispatch({
        dispatch,
        env,
        signal: controller.signal,
      })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(reconciliationDeadlineError());
          reject(reconciliationDeadlineError());
        }, remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const claimDispatches = async ({ env, limit, commandId = "" }) => {
  const policy = resolveTourneyStorePolicy(env);
  const table = dispatchTable(policy.primaryBackend);
  const leaseId = crypto.randomUUID();
  return runTourneyTransaction({
    env,
    lockKey: "roo-tourney-email-dispatch",
    callback: async (sql) => {
      await setEmailMirrorContext({
        sql,
        policy,
        commandId: `email-claim:${leaseId}`,
      });
      const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
      const rows = commandId
        ? await sql`
            select * from ${sql(table)}
            where command_id = ${commandId} and (
              (status in ('pending', 'retry')
                and coalesce(next_attempt_at, '-infinity'::timestamptz) <= now())
              or (status = 'sending' and lease_expires_at <= now())
            )
            order by created_at for update skip locked limit ${safeLimit}
          `
        : await sql`
            select * from ${sql(table)}
            where (status in ('pending', 'retry')
                and coalesce(next_attempt_at, '-infinity'::timestamptz) <= now())
              or (status = 'sending' and lease_expires_at <= now())
            order by created_at for update skip locked limit ${safeLimit}
          `;
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      await sql`
        update ${sql(table)}
        set status = 'sending', lease_id = ${leaseId},
            lease_expires_at = now() + interval '5 minutes',
            attempt_count = attempt_count + 1, updated_at = now()
        where id in ${sql(ids)}
      `;
      return rows.map((row) => ({
        ...row,
        lease_id: leaseId,
        attempt_count: Number(row.attempt_count || 0) + 1,
      }));
    },
  });
};

export const reconcileTourneyEmailDispatches = async ({
  env = process.env,
  limit = 10,
  commandId = "",
  deadlineAt,
} = {}) => {
  const policy = resolveTourneyStorePolicy(env);
  const table = dispatchTable(policy.primaryBackend);
  assertBeforeDeadline(deadlineAt);
  const dispatches = await claimDispatches({ env, limit, commandId });
  let sent = 0;
  let retried = 0;
  let expired = 0;
  for (const dispatch of dispatches) {
    try {
      assertBeforeDeadline(deadlineAt);
      const response = await sendBeforeDeadline({ dispatch, env, deadlineAt });
      assertBeforeDeadline(deadlineAt);
      const providerMessageId = Array.isArray(response)
        ? normalize(response[0]?.id)
        : normalize(response?.id);
      await runTourneyTransaction({
        env,
        lockKey: `roo-tourney-email-complete:${dispatch.id}`,
        callback: async (sql) => {
          await setEmailMirrorContext({
            sql,
            policy,
            commandId: `email-complete:${dispatch.id}:${dispatch.attempt_count + 1}`,
          });
          const rows = await sql`
            update ${sql(table)}
            set status = 'sent', provider_message_id = ${providerMessageId || null},
                sent_at = now(), lease_id = null, lease_expires_at = null,
                last_error_code = null, updated_at = now()
            where id = ${dispatch.id} and lease_id = ${dispatch.lease_id}
            returning id
          `;
          if (rows.length !== 1) {
            throw Object.assign(new Error("Tourney email lease changed."), {
              code: "TOURNEY_EMAIL_LEASE_MISMATCH",
            });
          }
        },
      });
      sent += 1;
    } catch (error) {
      const resetExpired = error?.code === "TOURNEY_RESET_DISPATCH_EXPIRED";
      const deadlineExceeded =
        error?.code === "TOURNEY_RECONCILIATION_DEADLINE_EXCEEDED";
      if (deadlineExceeded) throw error;
      const terminal = Number(dispatch.attempt_count || 0) >= 12;
      await runTourneyTransaction({
        env,
        lockKey: `roo-tourney-email-retry:${dispatch.id}`,
        callback: async (sql) => {
          await setEmailMirrorContext({
            sql,
            policy,
            commandId: `email-retry:${dispatch.id}:${dispatch.attempt_count + 1}`,
          });
          await sql`
            update ${sql(table)}
            set status = ${resetExpired ? "expired" : terminal ? "dead_letter" : "retry"},
                next_attempt_at = case
                  when ${resetExpired || terminal} then null
                  else now() + make_interval(
                    secs => least(3600, 2 ^ least(attempt_count, 11))
                  )
                end,
                lease_id = null, lease_expires_at = null,
                last_error_code = ${normalize(error?.code || "TOURNEY_EMAIL_FAILED").slice(0, 128)},
                updated_at = now()
            where id = ${dispatch.id} and lease_id = ${dispatch.lease_id}
          `;
        },
      });
      if (resetExpired) {
        expired += 1;
      } else {
        retried += 1;
      }
    }
  }
  return { claimed: dispatches.length, sent, retried, expired };
};

export const repairTourneyEmailDispatch = async ({
  actor,
  dispatchId,
  env = process.env,
  historicalOverride = false,
  reason,
} = {}) => {
  const normalizedDispatchId = normalize(dispatchId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(normalizedDispatchId)) {
    throw Object.assign(new Error("Tourney email repair target is invalid."), {
      code: "TOURNEY_REPAIR_TARGET_INVALID",
      status: 400,
    });
  }
  if (typeof historicalOverride !== "boolean") {
    throw Object.assign(new Error("Tourney email historical override is invalid."), {
      code: "TOURNEY_EMAIL_REPAIR_OVERRIDE_INVALID",
      status: 400,
    });
  }
  const policy = resolveTourneyStorePolicy(env);
  const table = dispatchTable(policy.primaryBackend);
  return runAuditedTourneyQueueRepair({
    actor,
    env,
    reason,
    targetId: normalizedDispatchId,
    targetType: "email_dispatch",
    callback: async ({ actor: repairActor, reason: repairReason, sql }) => {
      const dispatches = await sql`
        select id, dispatch_kind, status
        from ${sql(table)}
        where id = ${normalizedDispatchId}::uuid
        for update
      `;
      const dispatch = dispatches[0];
      if (!dispatch) {
        throw Object.assign(new Error("Tourney email dispatch was not found."), {
          code: "TOURNEY_EMAIL_DISPATCH_NOT_FOUND",
          status: 404,
        });
      }
      const isHistorical = dispatch.status === "historical_unknown";
      const repairable = ["dead_letter", "failed"].includes(dispatch.status) ||
        (isHistorical && historicalOverride === true);
      if (!repairable) {
        throw Object.assign(new Error("Tourney email dispatch is not repairable."), {
          code: isHistorical
            ? "TOURNEY_EMAIL_HISTORICAL_OVERRIDE_REQUIRED"
            : "TOURNEY_EMAIL_DISPATCH_NOT_REPAIRABLE",
          status: 409,
        });
      }
      const rows = await sql`
        update ${sql(table)} set
          status = 'pending', attempt_count = 0, next_attempt_at = now(),
          lease_id = null, lease_expires_at = null, last_error_code = null,
          audited_override_at = case
            when status = 'historical_unknown' then now()
            else audited_override_at
          end,
          audited_override_by = case
            when status = 'historical_unknown' then ${repairActor}
            else audited_override_by
          end,
          audited_override_reason = case
            when status = 'historical_unknown' then ${repairReason}
            else audited_override_reason
          end,
          updated_at = now()
        where id = ${normalizedDispatchId}::uuid
          and (
            status in ('dead_letter','failed')
            or (status = 'historical_unknown' and ${historicalOverride === true})
          )
        returning id
      `;
      if (rows.length !== 1) {
        throw Object.assign(new Error("Tourney email dispatch changed during repair."), {
          code: "TOURNEY_EMAIL_REPAIR_CONFLICT",
          status: 409,
        });
      }
      return {
        auditEvidence: {
          dispatchKind: normalize(dispatch.dispatch_kind),
          historicalOverride: isHistorical,
          previousStatus: dispatch.status,
          status: "pending",
        },
        dispatchKind: normalize(dispatch.dispatch_kind),
        historicalOverride: isHistorical,
        previousStatus: dispatch.status,
        status: "pending",
      };
    },
  });
};

export const hasPendingTourneyEmailDispatches = async ({
  commandId,
  env = process.env,
} = {}) => {
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") return false;
  const policy = resolveTourneyStorePolicy(env);
  const table = dispatchTable(policy.primaryBackend);
  const sql = await getTourneySql(env);
  const [row] = await sql`
    select exists(
      select 1 from ${sql(table)}
      where command_id = ${commandId}
        and status in ('pending', 'sending', 'retry', 'failed', 'dead_letter')
    ) as pending
  `;
  return row?.pending === true;
};
