import {
  authenticateSupabaseAccount,
  createSupabaseCreatorAccount,
  requireSupabaseBearerUser,
  syncSupabaseTourneyAdminAccount,
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
});
