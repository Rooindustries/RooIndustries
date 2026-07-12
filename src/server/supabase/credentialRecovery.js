import { createRefWriteClient } from "../api/ref/sanity.js";
import { createSupabaseAdminClient } from "./adminClient.js";
import { completeSupabaseCredentialMirror } from "./accounts.js";

const mark = (client, operationKey, status, errorCode = null) =>
  client.rpc("roo_mark_credential_operation", {
    p_operation_key: operationKey,
    p_status: status,
    p_error_code: errorCode,
  });

export const reconcileCredentialOperations = async ({
  limit = 10,
  adminClient = createSupabaseAdminClient(),
  sanityClient = createRefWriteClient({ backendOverride: "sanity" }),
} = {}) => {
  const pending = await adminClient.rpc("roo_list_credential_recovery", {
    p_limit: Math.max(1, Math.min(Number(limit) || 10, 25)),
  });
  if (pending.error) throw new Error("Credential recovery queue is unavailable.");
  const rows = Array.isArray(pending.data) ? pending.data : [];
  const summary = { checked: rows.length, recovered: 0, pending: 0 };
  for (const row of rows) {
    try {
      if (row.status === "prepared") {
        const updated = await adminClient.auth.admin.updateUserById(row.user_id, {
          password_hash: row.password_hash,
        });
        if (updated.error) throw new Error("Auth credential recovery failed.");
        const checkpoint = await mark(
          adminClient,
          row.operation_key,
          "auth_applied"
        );
        if (checkpoint.error) throw new Error("Credential checkpoint failed.");
      }
      if (!row.creator_legacy_sanity_id) {
        throw new Error("Creator credential target was not found.");
      }
      const referral = await sanityClient.fetch(
        `*[_id == $id][0]{_id,_rev,creatorPassword}`,
        { id: row.creator_legacy_sanity_id }
      );
      if (!referral?._id) throw new Error("Creator credential target was not found.");
      if (String(referral.creatorPassword || "") !== String(row.password_hash || "")) {
        if (row.source_revision && referral._rev !== row.source_revision) {
          const conflict = new Error("Creator credential revision changed.");
          conflict.code = "SOURCE_REVISION_CONFLICT";
          throw conflict;
        }
        let patch = sanityClient.patch(referral._id);
        if (referral._rev && typeof patch.ifRevisionId === "function") {
          patch = patch.ifRevisionId(referral._rev);
        }
        await patch
          .set({
            creatorPassword: row.password_hash,
            credentialVersion: 2,
            passwordLoginEnabled: true,
            passwordResetRequired: false,
            passwordChangedAt: new Date().toISOString(),
          })
          .commit({ visibility: "sync" });
      }
      await completeSupabaseCredentialMirror({
        operationKey: row.operation_key,
        adminClient,
      });
      summary.recovered += 1;
    } catch (error) {
      summary.pending += 1;
      await mark(
        adminClient,
        row.operation_key,
        "auth_applied",
        String(error?.code || "CREDENTIAL_RECOVERY_PENDING").slice(0, 128)
      ).catch(() => {});
    }
  }
  return summary;
};
