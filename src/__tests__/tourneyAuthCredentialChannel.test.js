import fs from "node:fs";
import path from "node:path";
import {
  syncSupabaseTourneyAdminAccount,
  createSupabaseCreatorAccount,
} from "../server/supabase/accounts.js";
import { queueSyncedDiscordDesiredStateBestEffort } from "../server/tourney/externalOperations.js";

// Supabase Auth honours `password_hash` on createUser and silently discards it on
// updateUserById -- HTTP 200, credential unchanged. Every admin account already exists,
// so admin password changes reported success while leaving the old password working.
// The digest cannot travel to the deferred worker and change anything; the submitted
// plaintext has to, through the encrypted operation-secret channel.
//
// These tests cover the three properties that a mocked admin client can actually
// establish: the plaintext reaches updateUserById, a caller that claims to be changing
// a credential without one fails instead of reporting success, and the plaintext is
// never written into the queued operation's readable desired_state.

const authUserId = "b1a17dc8-25dc-4e1e-8a12-3a3ab6bd25a0";
const bcryptHash = "$2b$12$l.tnAOrcYqG8QeK9OEJkYe0loikD0aohUP3vkp7PLCdZAWLsxmfjm";

const account = {
  username: "serviroo",
  email: "owner@example.com",
  role: "owner",
  passwordHash: bcryptHash,
  active: true,
  version: "4",
  principalId: authUserId,
};

const buildAdminClient = ({ existingUser = null } = {}) => {
  const calls = { update: [], create: [], rpc: [] };
  return {
    calls,
    auth: {
      admin: {
        getUserById: jest.fn().mockResolvedValue(
          existingUser
            ? { data: { user: existingUser }, error: null }
            : { data: { user: null }, error: { status: 404 } }
        ),
        updateUserById: jest.fn(async (id, attributes) => {
          calls.update.push({ id, attributes });
          return { data: { user: { id } }, error: null };
        }),
        createUser: jest.fn(async (attributes) => {
          calls.create.push(attributes);
          return { data: { user: { id: attributes.id || authUserId } }, error: null };
        }),
        deleteUser: jest.fn(async () => ({ data: null, error: null })),
      },
    },
    rpc: jest.fn(async (name, args) => {
      calls.rpc.push({ name, args });
      if (name === "roo_resolve_tourney_account_alias" || name === "roo_resolve_account_alias") {
        return {
          data: existingUser
            ? { user_id: authUserId, roles: ["creator", "tourney_owner"] }
            : null,
          error: null,
        };
      }
      if (name === "roo_account_by_user_id") {
        return {
          data: {
            user_id: authUserId,
            principal_id: authUserId,
            verified_real_email: account.email,
          },
          error: null,
        };
      }
      return { data: {}, error: null };
    }),
  };
};

const existingAdminAuthUser = {
  id: authUserId,
  email: account.email,
  app_metadata: { roles: ["tourney_owner"], imported_from: "tourney-accounts" },
  user_metadata: {},
};

describe("tourney administrator Auth password changes", () => {
  test("sends the submitted plaintext and never password_hash on update", async () => {
    const adminClient = buildAdminClient({ existingUser: existingAdminAuthUser });

    await syncSupabaseTourneyAdminAccount({
      account,
      password: "the-owners-new-password",
      installPassword: true,
      adminClient,
      env: { NODE_ENV: "test" },
    });

    const [{ attributes }] = adminClient.calls.update;
    expect(attributes.password).toBe("the-owners-new-password");
    expect(attributes).not.toHaveProperty("password_hash");
  });

  test("refuses to report a credential change it could not apply", async () => {
    const adminClient = buildAdminClient({ existingUser: existingAdminAuthUser });

    // This is the exact shape that used to succeed: installPassword with only a
    // digest available. Auth returned 200 and kept the previous password.
    await expect(
      syncSupabaseTourneyAdminAccount({
        account,
        password: "",
        installPassword: true,
        adminClient,
        env: { NODE_ENV: "test" },
      })
    ).rejects.toMatchObject({ code: "SUPABASE_AUTH_PASSWORD_PLAINTEXT_REQUIRED" });
  });

  test("re-projects metadata without a plaintext when no credential is changing", async () => {
    const adminClient = buildAdminClient({ existingUser: existingAdminAuthUser });

    // Role edits, disables and removals fan out over every account in the snapshot.
    // They must not demand a password that was never submitted.
    await syncSupabaseTourneyAdminAccount({
      account,
      installPassword: false,
      adminClient,
      env: { NODE_ENV: "test" },
    });

    const [{ attributes }] = adminClient.calls.update;
    expect(attributes).not.toHaveProperty("password");
    expect(attributes).not.toHaveProperty("password_hash");
    expect(adminClient.calls.rpc.some((call) => call.name === "roo_import_account_v2")).toBe(true);
  });

  test("adopts a confirmed Auth-only Discord user instead of creating a duplicate", async () => {
    const discordUser = {
      id: authUserId,
      email: account.email,
      email_confirmed_at: "2026-08-11T23:58:55.179Z",
      app_metadata: { provider: "discord", roles: ["discord_member"] },
      user_metadata: { display_name: "Kimchi" },
    };
    const updateUserById = jest.fn(async () => ({
      data: { user: discordUser },
      error: null,
    }));
    const createUser = jest.fn();
    const rpc = jest.fn(async (name, args) => {
      if (name === "roo_resolve_tourney_account_alias" || name === "roo_resolve_account_alias") {
        return { data: null, error: null };
      }
      if (name === "roo_account_by_user_id") {
        return {
          data: {
            user_id: authUserId,
            principal_id: authUserId,
            verified_real_email: account.email,
          },
          error: null,
        };
      }
      return { data: { imported: true, args }, error: null };
    });
    const adminClient = {
      auth: {
        admin: {
          listUsers: jest.fn(async () => ({
            data: { users: [discordUser] },
            error: null,
          })),
          getUserById: jest.fn(async () => ({
            data: { user: discordUser },
            error: null,
          })),
          updateUserById,
          createUser,
        },
      },
      rpc,
    };

    await syncSupabaseTourneyAdminAccount({
      account: { ...account, role: "caster" },
      password: "kimchi-new-password",
      installPassword: true,
      adminClient,
      env: { NODE_ENV: "test" },
    });

    expect(updateUserById).toHaveBeenCalledWith(
      authUserId,
      expect.objectContaining({
        password: "kimchi-new-password",
        app_metadata: expect.objectContaining({
          provider: "discord",
          roles: expect.arrayContaining(["discord_member", "tourney_caster"]),
        }),
      })
    );
    expect(createUser).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "roo_import_account_v2",
      expect.objectContaining({
        p_account: expect.objectContaining({ user_id: authUserId }),
      })
    );
  });

  test("never puts the plaintext into an RPC argument", async () => {
    const adminClient = buildAdminClient({ existingUser: existingAdminAuthUser });
    const secret = "admin-secret-must-not-persist-4417";

    await syncSupabaseTourneyAdminAccount({
      account,
      password: secret,
      installPassword: true,
      adminClient,
      env: { NODE_ENV: "test" },
    });

    expect(JSON.stringify(adminClient.calls.rpc)).not.toContain(secret);
  });
});

describe("post-Auth Discord role refresh", () => {
  test("does not keep a completed credential projection pending", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const queue = jest.fn().mockRejectedValue(
      Object.assign(new Error("Discord role assignment request is invalid"), {
        code: "22023",
      })
    );

    try {
      await expect(
        queueSyncedDiscordDesiredStateBestEffort({
          operation: { command_id: "password-reset-command" },
          synced: { userId: authUserId },
          env: { NODE_ENV: "test" },
          queue,
        })
      ).resolves.toBeNull();
      expect(queue).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        "Tourney Discord role refresh deferred after Auth synchronization",
        expect.objectContaining({ code: "22023" })
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("the queued operation payload", () => {
  const accountStore = fs.readFileSync(
    path.resolve("src/server/tourney/accountStore.js"),
    "utf8"
  );
  const playerStore = fs.readFileSync(
    path.resolve("src/server/tourney/playerStore.js"),
    "utf8"
  );
  const externalOperations = fs.readFileSync(
    path.resolve("src/server/tourney/externalOperations.js"),
    "utf8"
  );
  const registerRoute = fs.readFileSync(
    path.resolve("app/api/tourney/register/route.js"),
    "utf8"
  );

  test("carries installPassword but never the password itself", () => {
    // desired_state is stored as plain JSON in Postgres. The plaintext goes through
    // tourney.external_operation_secrets, which is AES-256-GCM sealed and
    // service_role-only.
    expect(accountStore).toContain("installPassword: changesCredential,");
    expect(accountStore).not.toMatch(/desiredState:[\s\S]{0,400}password:\s*(submitted|credential)/);
    expect(playerStore).toContain("installPassword: changesCredential,");
    expect(playerStore).not.toMatch(/desiredState:[\s\S]{0,400}password:\s*plaintext/);
  });

  test("scopes the credential signal to the one mutated account", () => {
    // The enqueue loop fans out over every account in the snapshot plus tombstones.
    // An unscoped signal repeats the regression that broke approve/kick/withdraw.
    expect(accountStore).toContain("String(account.username || \"\").trim().toLowerCase() === credentialTarget");
  });

  test("requires player Auth projection before registration reports success", () => {
    expect(registerRoute).toContain(
      'requiredExternalOperationKinds: ["supabase_player_auth"]'
    );
  });

  test("fails inside the transaction when the secret channel is unavailable", () => {
    // Committing an operation that promises to install a password whose plaintext
    // cannot be read back guarantees a worker error after the user was told the
    // change succeeded.
    for (const source of [accountStore, playerStore]) {
      expect(source).toContain("TOURNEY_AUTH_PASSWORD_CHANNEL_UNAVAILABLE");
    }
  });

  test("both workers require the plaintext when installPassword is set", () => {
    expect(externalOperations).toContain("tourney_admin_auth_password_unavailable");
    expect(externalOperations).toContain("tourney_player_auth_password_unavailable");
    // Strict equality, not truthiness: a legacy row without the key must read as
    // "no credential change", not as one.
    expect(externalOperations).toMatch(/state\.installPassword === true/);
  });

  test("no longer writes to Auth inside the command transaction", () => {
    // syncTourneyPlayerAuth runs inside executeTourneyCommand's transaction. An
    // inline Auth write there would survive a rollback of the Postgres side.
    const start = playerStore.indexOf("const syncTourneyPlayerAuth = async");
    const end = playerStore.indexOf("export const hashTourneyToken");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = playerStore.slice(start, end);
    expect(body).not.toContain("syncSupabaseTourneyPlayerAccount");
  });
});

describe("a superseded operation still installs the credential it carries", () => {
  // Moving the password write behind the queue put it under the workers' supersede
  // checks, which were written for metadata projections. Those are safe to drop -- the
  // newer row enqueued its own -- but the plaintext exists only in this operation's
  // secret, so dropping it would report a successful reset that never reached Auth.
  const { isTourneyPlayerCredentialCurrent } = require("../server/tourney/externalOperations.js");
  const externalOperations = fs.readFileSync(
    path.resolve("src/server/tourney/externalOperations.js"),
    "utf8"
  );

  test("the digest, not the version, decides credential ownership", () => {
    const desired = { id: "p1", status: "approved", version: 4, password_hash: bcryptHash };
    // Version moved on, digest still ours: the plaintext belongs to this row.
    expect(isTourneyPlayerCredentialCurrent({
      current: { ...desired, version: 9 },
      desired,
    })).toBe(true);
    // Digest replaced: a newer operation owns the credential, ours is stale.
    expect(isTourneyPlayerCredentialCurrent({
      current: { ...desired, password_hash: `${bcryptHash}x` },
      desired,
    })).toBe(false);
    // A different row, or a row with no digest at all, is never a target.
    expect(isTourneyPlayerCredentialCurrent({
      current: { ...desired, id: "p2" },
      desired,
    })).toBe(false);
    expect(isTourneyPlayerCredentialCurrent({
      current: { ...desired, password_hash: "" },
      desired: { ...desired, password_hash: "" },
    })).toBe(false);
    expect(isTourneyPlayerCredentialCurrent({})).toBe(false);
  });

  test("the player worker does not return superseded while holding a credential", () => {
    expect(externalOperations).toContain(
      "if (!carriesCredential ||\n      !isTourneyPlayerCredentialCurrent({ current: before, desired: state.player })) {"
    );
  });

  test("the admin worker does not return superseded while holding a credential", () => {
    expect(externalOperations).toContain(
      "if (!initial.current && !(carriesCredential && initial.credentialCurrent)) {"
    );
    // An account absent from the live snapshot has nothing to install onto.
    expect(externalOperations).toContain("account && digestOf(effectiveAccount) &&");
  });

  test("neither retry loop carries the plaintext onto a digest it does not own", () => {
    // The loops retarget at whatever row the finalize transaction observed. Installing
    // unconditionally there would overwrite a concurrent password change.
    expect(externalOperations).toContain("password: installNow ? submittedPassword : \"\"");
    expect(externalOperations).toContain("installPassword: installNow,");
    expect(externalOperations).toMatch(
      /const installNow = installPassword && \(!retargeted \|\|\s*isTourneyPlayerCredentialCurrent/
    );
    expect(externalOperations).toMatch(
      /const installNow = carriesCredential &&\s*normalize\(accountToSync\?\.passwordHash/
    );
  });
});

describe("creator verification retries", () => {
  test("a re-run against an already-installed digest is allowed to proceed", async () => {
    // The Auth user is created before Sanity is patched to `active`. If that patch
    // fails, the retry meets an existing Auth user with only a digest available.
    // Blocking it unconditionally left verification permanently stuck.
    const fingerprint = require("node:crypto")
      .createHash("sha256")
      .update(`credential:v1:${bcryptHash}`)
      .digest("hex");
    const adminClient = buildAdminClient({
      existingUser: {
        id: authUserId,
        email: account.email,
        app_metadata: { credential_digest_fingerprint: fingerprint },
        user_metadata: {},
      },
    });

    const result = await createSupabaseCreatorAccount({
      referral: {
        _id: "referral-1",
        creatorEmail: account.email,
        slug: { current: "servi" },
        name: "Servi",
        registrationStatus: "active",
      },
      passwordHash: bcryptHash,
      adminClient,
    });

    expect(result.userId).toBe(authUserId);
    const [{ attributes }] = adminClient.calls.update;
    expect(attributes).not.toHaveProperty("password_hash");
    expect(attributes).not.toHaveProperty("password");
  });

  test("a genuinely different digest with no plaintext still fails closed", async () => {
    // No fingerprint match means the digest differs from what Auth holds. That is a
    // real credential change, and a digest cannot perform one on an update.
    const adminClient = buildAdminClient({
      existingUser: {
        id: authUserId,
        email: account.email,
        app_metadata: { credential_digest_fingerprint: "a-different-credential" },
        user_metadata: {},
      },
    });

    await expect(
      createSupabaseCreatorAccount({
        referral: {
          _id: "referral-1",
          creatorEmail: account.email,
          slug: { current: "servi" },
          name: "Servi",
          registrationStatus: "active",
        },
        passwordHash: bcryptHash,
        adminClient,
      })
    ).rejects.toMatchObject({ code: "SUPABASE_AUTH_PASSWORD_PLAINTEXT_REQUIRED" });
  });

  test("the fingerprint is recorded only when a credential was really installed", () => {
    // The fingerprint means "Auth is holding this digest". createUser honours
    // password_hash, so it may claim that; an update only installs a credential when it
    // carries a plaintext. Claiming it after a metadata-only update would make a later
    // run read "already installed" and skip a real password change -- the same class of
    // silent no-op this whole commit exists to remove.
    const source = fs.readFileSync(
      path.resolve("src/server/supabase/accounts.js"),
      "utf8"
    );
    expect(source).toContain(
      "...(plaintext && digestFingerprint\n          ? { credential_digest_fingerprint: digestFingerprint }"
    );
    expect(source).toContain(
      "...(applyPassword && digestFingerprint\n          ? { credential_digest_fingerprint: digestFingerprint }"
    );
    expect(source).toContain(
      "...(plaintext ? (authAttributes.app_metadata || {}) : {}),"
    );
  });

  test("the fingerprint is not the digest", () => {
    // app_metadata is readable with the service key, and a bcrypt digest is still
    // offline-attackable. The stored value must not be the digest itself.
    const source = fs.readFileSync(
      path.resolve("src/server/supabase/accounts.js"),
      "utf8"
    );
    expect(source).toContain("createHash(\"sha256\").update(`credential:v1:${digest}`)");
    const fingerprint = require("node:crypto")
      .createHash("sha256")
      .update(`credential:v1:${bcryptHash}`)
      .digest("hex");
    expect(fingerprint).not.toContain(bcryptHash);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the operator migration script", () => {
  const source = fs.readFileSync(
    path.resolve("scripts/migrate-sanity-to-supabase.mjs"),
    "utf8"
  );

  test("stops sending password_hash on the update path", () => {
    expect(source).toContain("const { password_hash: _honouredOnCreateOnly, ...updatable } = authAttributes;");
    expect(source).toContain("updateUserById(\n        account.userId,\n        updatable\n      )");
  });

  test("reports the accounts whose digest could not be installed", () => {
    // Counting these as `updated` reported a successful credential import that never
    // happened.
    expect(source).toContain("credentialSkipped");
    expect(source).toContain("if (account.passwordHash) credentialSkipped += 1;");
    expect(source).toMatch(/return \{ total: accounts\.length, created, updated, pending, credentialSkipped \}/);
  });
});
