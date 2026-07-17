import {
  authenticateSupabaseAccount,
  buildCredentialSourcePreconditions,
  buildTourneyPlayerAuthEmail,
  completeSupabaseCredentialMirror,
  createSupabaseCreatorAccount,
  requireSupabaseBearerUser,
  syncSupabaseTourneyAdminAccount,
  syncSupabaseTourneyPlayerAccount,
  updateSupabaseAccountPassword,
} from "../server/supabase/accounts";

const creatorAccount = {
  user_id: "22fb353c-429e-4db2-89de-602aba57f64c",
  primary_email: "creator@example.com",
  display_name: "Creator",
  status: "active",
  credential_status: "imported",
  credential_kind: "bcrypt",
  roles: ["customer", "creator"],
  referral_code: "creator",
};

describe("Supabase account compatibility", () => {
  test("updates an existing Auth password with plaintext and stores only its hash", async () => {
    const passwordHash = `$2b$12$${"a".repeat(53)}`;
    const updateUserById = jest.fn().mockResolvedValue({
      data: { user: { id: creatorAccount.user_id } },
      error: null,
    });
    const adminClient = {
      auth: { admin: { updateUserById } },
      rpc: jest.fn(async (name) => {
        if (name === "roo_resolve_account_alias") {
          return { data: creatorAccount, error: null };
        }
        if (name === "roo_prepare_credential_operation_v2") {
          return {
            data: {
              password_hash: passwordHash,
              source_mutation: { set: { creatorPassword: passwordHash } },
              source_preconditions: { credentialVersion: 2 },
              status: "prepared",
            },
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
      updateSupabaseAccountPassword({
        adminClient,
        identifier: "creator@example.com",
        operationKey: "credential:test:plaintext",
        password: "new-password-value",
        passwordHash,
        sourceBackend: "supabase",
        sourceDocumentId: "referral.creator",
        sourceMutation: { set: { creatorPassword: passwordHash } },
        sourcePreconditions: { credentialVersion: 2 },
        sourceRevision: "source-r1",
      })
    ).resolves.toMatchObject({
      passwordHash,
      updated: true,
    });
    expect(updateUserById).toHaveBeenCalledWith(creatorAccount.user_id, {
      password: "new-password-value",
    });
  });

  test("omits absent document fields from credential preconditions", () => {
    expect(
      buildCredentialSourcePreconditions({
        document: {
          creatorPassword: "stored-hash",
          credentialVersion: 2,
          resetTokenExpiresAt: null,
          resetTokenHash: null,
        },
      })
    ).toEqual({
      creatorPassword: "stored-hash",
      credentialVersion: 2,
    });
  });

  test("derives one normalized synthetic Auth email for Tourney players", () => {
    expect(buildTourneyPlayerAuthEmail("  Player-One  ")).toBe(
      buildTourneyPlayerAuthEmail("player-one")
    );
  });

  test("authenticates an imported bcrypt creator through an alias", async () => {
    const adminClient = {
      rpc: jest.fn().mockResolvedValue({ data: creatorAccount, error: null }),
    };
    const authClient = {
      auth: {
        signInWithPassword: jest.fn().mockResolvedValue({
          data: {
            user: { id: creatorAccount.user_id },
            session: { access_token: "session-token" },
          },
          error: null,
        }),
      },
    };

    const result = await authenticateSupabaseAccount({
      identifier: "CREATOR",
      password: "valid-password",
      requiredRoles: ["creator"],
      adminClient,
      authClient,
    });
    expect(result.ok).toBe(true);
    expect(authClient.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "creator@example.com",
      password: "valid-password",
    });
  });

  test("does not fall through to another role for a scoped login", async () => {
    const adminClient = {
      rpc: jest.fn().mockResolvedValue({ data: creatorAccount, error: null }),
    };
    const authClient = { auth: { signInWithPassword: jest.fn() } };
    const result = await authenticateSupabaseAccount({
      identifier: "creator@example.com",
      password: "valid-password",
      requiredRoles: ["tourney_player"],
      accountScope: "tourney",
      adminClient,
      authClient,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(authClient.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  test("requires a verified bearer identity", async () => {
    const adminClient = {
      rpc: jest.fn().mockResolvedValue({
        data: { ...creatorAccount, verified_real_email: null },
        error: null,
      }),
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: creatorAccount.user_id,
              email: "creator@example.com",
              email_confirmed_at: null,
            },
          },
          error: null,
        }),
      },
    };
    await expect(
      requireSupabaseBearerUser({
        authorization: "Bearer valid-token",
        adminClient,
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 403,
      reason: "email_not_verified",
    });
  });

  test("does not overwrite another account password when Tourney reuses an email", async () => {
    const adminClient = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: creatorAccount, error: null }),
      auth: {
        admin: {
          getUserById: jest.fn(),
          updateUserById: jest.fn(),
          createUser: jest.fn(),
        },
      },
    };

    await expect(
      syncSupabaseTourneyAdminAccount({
        account: {
          username: "different-login",
          email: "creator@example.com",
          role: "caster",
          passwordHash: "$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        adminClient,
      })
    ).rejects.toThrow("already linked");
    expect(adminClient.auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(adminClient.auth.admin.createUser).not.toHaveBeenCalled();
  });

  test("does not overwrite a non-creator account during creator registration", async () => {
    const tourneyAccount = {
      ...creatorAccount,
      roles: ["tourney_caster"],
    };
    const adminClient = {
      rpc: jest.fn().mockResolvedValue({ data: tourneyAccount, error: null }),
      auth: {
        admin: {
          createUser: jest.fn(),
          deleteUser: jest.fn(),
        },
      },
    };

    await expect(
      createSupabaseCreatorAccount({
        referral: {
          _id: "referral.creator",
          creatorEmail: "creator@example.com",
          slug: { current: "creator" },
          name: "Creator",
        },
        password: "valid-password",
        adminClient,
      })
    ).rejects.toThrow("already linked");
    expect(adminClient.auth.admin.createUser).not.toHaveBeenCalled();
  });

  test("rejects a Tourney username and email that resolve to different users", async () => {
    const existingTourneyAccount = {
      ...creatorAccount,
      user_id: "e94745f3-45bd-4890-b9d3-1b3263083cbd",
      roles: ["tourney_owner"],
    };
    const anotherTourneyAccount = {
      ...creatorAccount,
      user_id: "8b710c29-d782-4ff8-ac60-229e4038908a",
      roles: ["tourney_caster"],
    };
    const adminClient = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({ data: existingTourneyAccount, error: null })
        .mockResolvedValueOnce({ data: anotherTourneyAccount, error: null }),
      auth: {
        admin: {
          getUserById: jest.fn(),
          updateUserById: jest.fn(),
          createUser: jest.fn(),
        },
      },
    };

    await expect(
      syncSupabaseTourneyAdminAccount({
        account: {
          username: "serviroo",
          email: "creator@example.com",
          role: "owner",
          passwordHash: "$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        adminClient,
      })
    ).rejects.toThrow("already linked");
    expect(adminClient.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  test("completes credential mirroring and session revocation atomically", async () => {
    const adminClient = {
      rpc: jest.fn().mockResolvedValue({
        data: { status: "mirrored", session_version: 7 },
        error: null,
      }),
    };
    await expect(
      completeSupabaseCredentialMirror({
        operationKey: "credential:test",
        adminClient,
      })
    ).resolves.toEqual({ sessionVersion: 7 });
    expect(adminClient.rpc).toHaveBeenCalledTimes(1);
    expect(adminClient.rpc).toHaveBeenCalledWith(
      "roo_complete_credential_operation",
      { p_operation_key: "credential:test" }
    );
  });

  test("adds Tourney access to a creator principal without replacing its password", async () => {
    const user = {
      id: creatorAccount.user_id,
      app_metadata: { roles: ["creator"] },
    };
    const dualAccount = {
      ...creatorAccount,
      roles: ["creator", "tourney_player"],
      tourney_username: "player-one",
    };
    const adminClient = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({
          data: { ...creatorAccount, verified_real_email: "creator@example.com" },
          error: null,
        })
        .mockResolvedValueOnce({ data: { imported: true }, error: null })
        .mockResolvedValueOnce({ data: dualAccount, error: null }),
      auth: {
        admin: {
          getUserById: jest.fn().mockResolvedValue({ data: { user }, error: null }),
          updateUserById: jest.fn().mockResolvedValue({ data: { user }, error: null }),
        },
      },
    };
    await expect(
      syncSupabaseTourneyPlayerAccount({
        adminClient,
        authUserId: user.id,
        env: {},
        installPassword: false,
        passwordHash: "$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        player: {
          id: "player.one",
          username: "player-one",
          email: "creator@example.com",
          status: "approved",
        },
      })
    ).resolves.toMatchObject({ userId: user.id, account: dualAccount });
    const update = adminClient.auth.admin.updateUserById.mock.calls[0][1];
    expect(update).not.toHaveProperty("password");
    expect(update).not.toHaveProperty("password_hash");
    expect(update.app_metadata.roles).toEqual(
      expect.arrayContaining(["creator", "tourney_player"])
    );
  });

  test("does not perform inline Discord role refresh during player auth sync", async () => {
    const user = {
      id: creatorAccount.user_id,
      email: "player-auth@example.invalid",
      app_metadata: { roles: ["tourney_player"], legacy_player_id: "player.one" },
    };
    const account = {
      ...creatorAccount,
      principal_id: "31ccb7e7-69e4-49d1-a30c-43e37e8412c7",
      roles: ["tourney_player"],
      tourney_username: "player-one",
    };
    const adminClient = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({ data: account, error: null })
        .mockResolvedValueOnce({ data: { imported: true }, error: null })
        .mockResolvedValueOnce({ data: account, error: null }),
      auth: {
        admin: {
          getUserById: jest.fn().mockResolvedValue({ data: { user }, error: null }),
          updateUserById: jest.fn().mockResolvedValue({ data: { user }, error: null }),
        },
      },
    };

    await expect(syncSupabaseTourneyPlayerAccount({
      adminClient,
      env: { DISCORD_GUILD_ID: "111111111111111111" },
      installPassword: false,
      passwordHash: "$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      player: {
        id: "player.one",
        username: "player-one",
        email: "player@example.com",
        status: "withdrawn",
        version: 4,
      },
    })).resolves.toMatchObject({
      principalId: account.principal_id,
      discordRoleAssignment: null,
    });
    expect(adminClient.rpc.mock.calls.some(
      ([name]) => name === "roo_refresh_discord_role_assignment"
    )).toBe(false);
  });

  test("adds creator access to a Tourney principal without creating a second Auth user", async () => {
    const tourneyAccount = {
      ...creatorAccount,
      roles: ["tourney_player"],
      verified_real_email: "creator@example.com",
    };
    const dualAccount = {
      ...tourneyAccount,
      roles: ["creator", "tourney_player"],
    };
    const user = {
      id: creatorAccount.user_id,
      app_metadata: { roles: ["tourney_player"] },
      user_metadata: {},
    };
    const adminClient = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: tourneyAccount, error: null })
        .mockResolvedValueOnce({ data: { imported: true }, error: null })
        .mockResolvedValueOnce({ data: {}, error: null })
        .mockResolvedValueOnce({ data: dualAccount, error: null }),
      auth: {
        admin: {
          getUserById: jest.fn().mockResolvedValue({ data: { user }, error: null }),
          updateUserById: jest.fn().mockResolvedValue({ data: { user }, error: null }),
          createUser: jest.fn(),
          deleteUser: jest.fn(),
        },
      },
    };
    await expect(
      createSupabaseCreatorAccount({
        adminClient,
        authUserId: user.id,
        referral: {
          _id: "referral.creator",
          creatorEmail: "creator@example.com",
          slug: { current: "creator" },
          name: "Creator",
        },
      })
    ).resolves.toMatchObject({ userId: user.id, account: dualAccount });
    expect(adminClient.auth.admin.createUser).not.toHaveBeenCalled();
    const update = adminClient.auth.admin.updateUserById.mock.calls[0][1];
    expect(update).not.toHaveProperty("password");
    expect(update.app_metadata.roles).toEqual(
      expect.arrayContaining(["creator", "tourney_player"])
    );
  });
});
