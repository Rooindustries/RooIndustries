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

const normalize = (value) => String(value || "").trim();
const recipientHash = (value) =>
  crypto
    .createHash("sha256")
    .update(normalize(value).toLowerCase())
    .digest("hex");
const dispatchTable = (backend) =>
  backend === "supabase" ? "tourney.email_dispatches" : "tourney_email_dispatches";
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
  historical = false,
  env = process.env,
} = {}) => {
  const normalizedRecipient = normalize(recipient);
  if (!normalizedRecipient) throw new Error("A Tourney email recipient is required.");
  const policy = resolveTourneyStorePolicy(env);
  const table = dispatchTable(policy.primaryBackend);
  const key = normalize(idempotencyKey) ||
    `${normalize(commandId)}:${normalize(dispatchKind)}:${recipientHash(normalizedRecipient).slice(0, 24)}`;
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

const sendDispatch = ({ dispatch, env }) => {
  const payload = dispatch.payload || {};
  const common = { ...payload, env, idempotencyKey: dispatch.idempotency_key };
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

const claimDispatches = async ({ env, limit }) => {
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
      const rows = await sql`
        select * from ${sql(table)}
        where (
          status in ('pending', 'retry')
          and coalesce(next_attempt_at, '-infinity'::timestamptz) <= now()
        ) or (
          status = 'sending' and lease_expires_at <= now()
        )
        order by created_at
        for update skip locked
        limit ${Math.max(1, Math.min(50, Number(limit) || 10))}
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
      return rows.map((row) => ({ ...row, lease_id: leaseId }));
    },
  });
};

export const reconcileTourneyEmailDispatches = async ({
  env = process.env,
  limit = 10,
} = {}) => {
  const policy = resolveTourneyStorePolicy(env);
  const table = dispatchTable(policy.primaryBackend);
  const dispatches = await claimDispatches({ env, limit });
  let sent = 0;
  let retried = 0;
  for (const dispatch of dispatches) {
    try {
      const response = await sendDispatch({ dispatch, env });
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
          await sql`
            update ${sql(table)}
            set status = 'sent', provider_message_id = ${providerMessageId || null},
                sent_at = now(), lease_id = null, lease_expires_at = null,
                last_error_code = null, updated_at = now()
            where id = ${dispatch.id} and lease_id = ${dispatch.lease_id}
          `;
        },
      });
      sent += 1;
    } catch (error) {
      const terminal = Number(dispatch.attempt_count || 0) + 1 >= 12;
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
            set status = ${terminal ? "failed" : "retry"},
                next_attempt_at = now() + make_interval(
                  secs => least(3600, 2 ^ least(attempt_count, 11))
                ),
                lease_id = null, lease_expires_at = null,
                last_error_code = ${normalize(error?.code || "TOURNEY_EMAIL_FAILED").slice(0, 128)},
                updated_at = now()
            where id = ${dispatch.id} and lease_id = ${dispatch.lease_id}
          `;
        },
      });
      retried += 1;
    }
  }
  return { claimed: dispatches.length, sent, retried };
};
