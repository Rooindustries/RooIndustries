import {
  reconcileCredentialOperations,
  reconcileSupabaseCredentialSource,
  resumeSupabaseCredentialOperation,
} from "../server/supabase/credentialRecovery";

const passwordHash = "$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const createSanityClient = (initial) => {
  const state = { document: { ...initial }, commits: 0 };
  const client = {
    fetch: jest.fn(async (_query, params) => {
      if (Array.isArray(params.ids)) {
        return params.ids.includes(state.document._id)
          ? [{ ...state.document }]
          : [];
      }
      return params.id && params.id !== state.document._id
        ? null
        : { ...state.document };
    }),
    patch: jest.fn(() => {
      const changes = { set: {}, unset: [] };
      const patch = {
        ifRevisionId: jest.fn(() => patch),
        set: jest.fn((values) => {
          changes.set = { ...values };
          return patch;
        }),
        unset: jest.fn((fields) => {
          changes.unset = [...fields];
          return patch;
        }),
        commit: jest.fn(async () => {
          Object.assign(state.document, changes.set);
          changes.unset.forEach((field) => delete state.document[field]);
          state.document._rev = `${state.document._rev}-next`;
          state.commits += 1;
          return { ...state.document };
        }),
      };
      return patch;
    }),
    transaction: jest.fn(() => {
      let replacement = null;
      const transaction = {
        createOrReplace: jest.fn((document) => {
          replacement = { ...document };
          return transaction;
        }),
        delete: jest.fn(() => transaction),
        commit: jest.fn(async () => {
          if (replacement) state.document = replacement;
          state.commits += 1;
          return { ok: true };
        }),
      };
      return transaction;
    }),
  };
  return { client, state };
};

const mutation = {
  set: {
    creatorPassword: passwordHash,
    credentialVersion: 2,
    passwordLoginEnabled: true,
    passwordResetRequired: false,
    passwordChangedAt: "2026-07-15T00:00:00.000Z",
  },
  unset: [
    "resetToken",
    "resetTokenHash",
    "resetTokenExpiresAt",
    "resetDeliveryToken",
  ],
};

describe("credential recovery saga", () => {
  test("recovers an Auth-applied Supabase reset through the durable mirror exactly once", async () => {
    const sanity = createSanityClient({
      _id: "referral.creator",
      _type: "referral",
      _rev: "sanity-old",
      resetTokenHash: "still-live",
      resetTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    const event = {
      sequence_no: "12",
      event_key: "12121212-1212-4212-8212-121212121212",
      document_ids: ["referral.creator"],
      documents: [
        {
          _id: "referral.creator",
          _type: "referral",
          _rev: "supabase-new",
          _supabaseRevision: "supabase-new",
          _supabaseCanonicalHash: "a".repeat(64),
          _supabaseSequence: "12",
          ...mutation.set,
        },
      ],
      deleted_documents: [],
    };
    let sourceAttempts = 0;
    let eventClaimed = false;
    let sessionVersion = 1;
    let completions = 0;
    const row = {
      operation_key: "credential:reset:one",
      user_id: "11111111-1111-4111-8111-111111111111",
      password_hash: passwordHash,
      status: "auth_applied",
      source_backend: "supabase",
      source_document_id: "referral.creator",
      source_expected_revision: "supabase-old",
      source_mutation: mutation,
    };
    const adminClient = {
      auth: { admin: { updateUserById: jest.fn() } },
      rpc: jest.fn(async (name) => {
        if (name === "roo_apply_credential_source_operation") {
          sourceAttempts += 1;
          if (sourceAttempts === 1) {
            return { data: null, error: { code: "SOURCE_WRITE_FAILED" } };
          }
          return {
            data: {
              source_document_id: "referral.creator",
              source_revision: "supabase-new",
            },
            error: null,
          };
        }
        if (name === "roo_list_credential_recovery") {
          return { data: [], error: null };
        }
        if (name === "roo_get_credential_operation") {
          return { data: row, error: null };
        }
        if (name === "roo_claim_document_mutation_mirror_events") {
          if (eventClaimed) return { data: [], error: null };
          eventClaimed = true;
          return { data: [event], error: null };
        }
        if (name === "roo_complete_document_mutation_mirror_event") {
          return { data: { status: "applied" }, error: null };
        }
        if (name === "roo_document_mutation_mirror_backlog") {
          return { data: { ready: true, pending: 0, dead_letters: 0 }, error: null };
        }
        if (name === "roo_document_mutation_mirror_status_for_ids") {
          return { data: { pending: 0, dead_letters: 0 }, error: null };
        }
        if (name === "roo_complete_credential_operation") {
          completions += 1;
          if (completions === 1) sessionVersion += 1;
          return {
            data: { status: "mirrored", session_version: sessionVersion },
            error: null,
          };
        }
        if (name === "roo_mark_credential_operation") {
          return { data: { status: "auth_applied" }, error: null };
        }
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };

    await expect(
      reconcileSupabaseCredentialSource({
        operationKey: row.operation_key,
        sourceDocumentId: row.source_document_id,
        adminClient,
        sanityClient: sanity.client,
      })
    ).rejects.toMatchObject({ code: "SOURCE_WRITE_FAILED" });
    expect(sanity.state.document.resetTokenHash).toBe("still-live");
    expect(completions).toBe(0);

    await expect(
      resumeSupabaseCredentialOperation({
        operationKey: row.operation_key,
        adminClient,
        sanityClient: sanity.client,
      })
    ).resolves.toEqual({ resumed: true, status: "auth_applied" });
    expect(sanity.state.document).toMatchObject({
      creatorPassword: passwordHash,
      _supabaseRevision: "supabase-new",
      _supabaseSequence: "12",
    });
    expect(sanity.state.document.resetTokenHash).toBeUndefined();
    expect(sanity.state.document.resetTokenExpiresAt).toBeUndefined();
    expect(sessionVersion).toBe(2);
    expect(completions).toBe(1);
    expect(adminClient.rpc).toHaveBeenCalledWith(
      "roo_mark_credential_operation",
      {
        p_operation_key: row.operation_key,
        p_status: "auth_applied",
        p_error_code: null,
      }
    );

    await expect(
      reconcileCredentialOperations({ adminClient, sanityClient: sanity.client })
    ).resolves.toEqual({ checked: 0, recovered: 0, pending: 0 });
    expect(sessionVersion).toBe(2);
    expect(completions).toBe(1);
  });

  test("uses the Sanity revision only for a Sanity-authoritative recovery", async () => {
    const sanity = createSanityClient({
      _id: "referral.legacy",
      _type: "referral",
      _rev: "sanity-r1",
      _supabaseRevision: "supabase-unrelated",
      resetTokenHash: "live",
    });
    const row = {
      operation_key: "credential:reset:legacy",
      user_id: "22222222-2222-4222-8222-222222222222",
      password_hash: passwordHash,
      status: "auth_applied",
      sessions_revoked_at: "2026-07-15T00:00:01.000Z",
      source_backend: "sanity",
      source_document_id: "referral.legacy",
      source_expected_revision: "sanity-r1",
      source_mutation: mutation,
    };
    let listed = false;
    const adminClient = {
      auth: { admin: { updateUserById: jest.fn() } },
      rpc: jest.fn(async (name, args) => {
        if (name === "roo_list_credential_recovery") {
          if (listed) return { data: [], error: null };
          listed = true;
          return { data: [row], error: null };
        }
        if (name === "roo_mark_credential_source_applied") {
          expect(args.p_source_revision).toBe("sanity-r1-next");
          return { data: { status: "source_applied" }, error: null };
        }
        if (name === "roo_complete_credential_operation") {
          return { data: { session_version: 3 }, error: null };
        }
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };

    await expect(
      reconcileCredentialOperations({ adminClient, sanityClient: sanity.client })
    ).resolves.toEqual({ checked: 1, recovered: 1, pending: 0 });
    expect(sanity.state.document.resetTokenHash).toBeUndefined();
    expect(sanity.state.document.creatorPassword).toBe(passwordHash);
  });

  test("keeps a prepared operation pending for the original password request", async () => {
    const sanity = createSanityClient({
      _id: "referral.auth-retry",
      _type: "referral",
      _rev: "sanity-r1",
      creatorPassword: "$2b$12$ccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      resetTokenHash: "retry-token",
    });
    const row = {
      operation_key: "credential:reset:auth-retry",
      user_id: "99999999-9999-4999-8999-999999999999",
      password_hash: passwordHash,
      status: "prepared",
      source_backend: "sanity",
      source_document_id: "referral.auth-retry",
      source_expected_revision: "sanity-r1",
      source_preconditions: { resetTokenHash: "retry-token" },
      source_mutation: mutation,
    };
    let listCount = 0;
    let completed = 0;
    const updateUserById = jest.fn();
    const adminClient = {
      auth: {
        admin: {
          updateUserById,
        },
      },
      rpc: jest.fn(async (name, args) => {
        if (name === "roo_list_credential_recovery") {
          listCount += 1;
          return { data: listCount <= 2 ? [{ ...row }] : [], error: null };
        }
        if (name === "roo_get_credential_operation") {
          return { data: { ...row }, error: null };
        }
        if (name === "roo_record_credential_recovery_error") {
          expect(args.p_expected_status).toBe("prepared");
          return { data: { status: "prepared" }, error: null };
        }
        if (name === "roo_mark_credential_operation") {
          return { data: { status: "auth_applied" }, error: null };
        }
        if (name === "roo_mark_credential_source_applied") {
          return { data: { status: "source_applied" }, error: null };
        }
        if (name === "roo_complete_credential_operation") {
          completed += 1;
          return { data: { session_version: 2 }, error: null };
        }
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };

    await expect(
      reconcileCredentialOperations({ adminClient, sanityClient: sanity.client })
    ).resolves.toEqual({ checked: 1, recovered: 0, pending: 1 });
    expect(sanity.state.document.resetTokenHash).toBe("retry-token");
    expect(sanity.state.commits).toBe(0);
    expect(completed).toBe(0);

    await expect(
      reconcileCredentialOperations({ adminClient, sanityClient: sanity.client })
    ).resolves.toEqual({ checked: 1, recovered: 0, pending: 1 });
    await expect(
      resumeSupabaseCredentialOperation({
        operationKey: row.operation_key,
        adminClient,
        sanityClient: sanity.client,
      })
    ).resolves.toEqual({ resumed: false, status: "prepared" });
    expect(sanity.state.document.resetTokenHash).toBe("retry-token");
    expect(sanity.state.commits).toBe(0);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(completed).toBe(0);
  });

  test("does not touch Auth or Sanity for a quarantined legacy operation", async () => {
    const sanity = createSanityClient({
      _id: "referral.quarantined",
      _type: "referral",
      _rev: "sanity-r1",
      resetTokenHash: "must-remain",
    });
    const updateUserById = jest.fn();
    const adminClient = {
      auth: { admin: { updateUserById } },
      rpc: jest.fn(async (name) => {
        if (name === "roo_get_credential_operation") {
          return {
            data: {
              operation_key: "credential:reset:quarantined",
              status: "prepared",
              source_backend: null,
              source_recovery_blocked: true,
            },
            error: null,
          };
        }
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };

    await expect(
      resumeSupabaseCredentialOperation({
        operationKey: "credential:reset:quarantined",
        adminClient,
        sanityClient: sanity.client,
      })
    ).rejects.toMatchObject({ code: "CREDENTIAL_SOURCE_REPAIR_REQUIRED" });
    expect(updateUserById).not.toHaveBeenCalled();
    expect(sanity.state.commits).toBe(0);
    expect(sanity.state.document.resetTokenHash).toBe("must-remain");
  });

  test("does not replay a completed Sanity source mutation after unrelated edits", async () => {
    const sanity = createSanityClient({
      _id: "referral.completed",
      _type: "referral",
      _rev: "sanity-r9",
      displayName: "Edited after reset",
      creatorPassword: passwordHash,
    });
    const updateUserById = jest.fn();
    const adminClient = {
      auth: { admin: { updateUserById } },
      rpc: jest.fn(async (name) => {
        if (name === "roo_get_credential_operation") {
          return {
            data: {
              operation_key: "credential:reset:completed",
              user_id: "77777777-7777-4777-8777-777777777777",
              password_hash: passwordHash,
              status: "mirrored",
              source_backend: "sanity",
              source_document_id: "referral.completed",
              source_applied_revision: "sanity-r2",
              source_mutation: mutation,
            },
            error: null,
          };
        }
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };

    await expect(
      resumeSupabaseCredentialOperation({
        operationKey: "credential:reset:completed",
        adminClient,
        sanityClient: sanity.client,
      })
    ).resolves.toEqual({ resumed: true, status: "mirrored" });
    expect(updateUserById).not.toHaveBeenCalled();
    expect(sanity.client.fetch).not.toHaveBeenCalled();
    expect(sanity.client.patch).not.toHaveBeenCalled();
    expect(sanity.state.commits).toBe(0);
    expect(sanity.state.document.displayName).toBe("Edited after reset");
  });
});
