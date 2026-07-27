import {
  createPendingDiscordLinkCookie,
  linkPendingDiscordIdentity,
  readPendingDiscordLink,
  resolvePendingDiscordUser,
  resolvePendingSocialLink,
} from "../server/supabase/pendingSocialLink";

const primaryUserId = "10000000-0000-4000-8000-000000000001";
const pendingUserId = "20000000-0000-4000-8000-000000000002";
const primaryAccount = {
  creator_active: true,
  principal_id: "30000000-0000-4000-8000-000000000003",
  roles: ["creator"],
};
const pendingAccount = {
  principal_id: "40000000-0000-4000-8000-000000000004",
  roles: [],
};
const tourneyAccount = {
  principal_id: primaryAccount.principal_id,
  roles: ["tourney_player"],
  status: "active",
  tourney_active: true,
  tourney_username: "player-one",
};

describe("pending Discord referral linking", () => {
  test("seals and resolves the pending Discord identity without an OAuth session cookie", async () => {
    const now = Date.parse("2026-07-17T08:00:00.000Z");
    const env = {
      NODE_ENV: "production",
      REF_SESSION_SECRET: "pending-link-test-secret",
    };
    const cookie = createPendingDiscordLinkCookie({
      env,
      intentId: "11111111-1111-4111-8111-111111111111",
      now,
      userId: pendingUserId,
    });
    const request = {
      headers: {
        cookie: `${cookie.name}=${encodeURIComponent(cookie.value)}`,
      },
    };

    expect(readPendingDiscordLink({ env, now: now + 1_000, request })).toEqual({
      intentId: "11111111-1111-4111-8111-111111111111",
      provider: "discord",
      userId: pendingUserId,
    });

    const getUserById = jest.fn().mockResolvedValue({
      data: {
        user: {
          id: pendingUserId,
          identities: [{ provider: "discord" }],
        },
      },
      error: null,
    });
    await expect(
      resolvePendingDiscordUser({
        adminClient: { auth: { admin: { getUserById } } },
        env,
        now: now + 1_000,
        request,
      })
    ).resolves.toMatchObject({ id: pendingUserId });
    expect(getUserById).toHaveBeenCalledWith(pendingUserId);
  });

  test("rejects tampered or expired pending Discord proofs", () => {
    const now = Date.parse("2026-07-17T08:00:00.000Z");
    const env = {
      NODE_ENV: "production",
      REF_SESSION_SECRET: "pending-link-test-secret",
    };
    const cookie = createPendingDiscordLinkCookie({
      env,
      intentId: "11111111-1111-4111-8111-111111111111",
      now,
      userId: pendingUserId,
    });
    const requestFor = (value) => ({
      headers: { cookie: `${cookie.name}=${encodeURIComponent(value)}` },
    });

    expect(
      readPendingDiscordLink({
        env,
        now: now + 1_000,
        request: requestFor(`${cookie.value}tampered`),
      })
    ).toBeNull();
    expect(
      readPendingDiscordLink({
        env,
        now: now + 15 * 60 * 1_000,
        request: requestFor(cookie.value),
      })
    ).toBeNull();
  });

  test("scopes a signed pending Discord proof to the Tourney login flow", () => {
    const now = Date.parse("2026-07-17T08:00:00.000Z");
    const env = {
      NODE_ENV: "production",
      TOURNEY_SESSION_SECRET: "pending-tourney-link-test-secret",
    };
    const cookie = createPendingDiscordLinkCookie({
      env,
      flow: "tourney",
      intentId: "11111111-1111-4111-8111-111111111111",
      now,
      userId: pendingUserId,
    });
    const requestFor = (value) => ({
      headers: { cookie: `${cookie.name}=${encodeURIComponent(value)}` },
    });

    expect(cookie.name).toBe("roo_pending_tourney_discord_link");
    expect(
      readPendingDiscordLink({
        env,
        flow: "tourney",
        now: now + 1_000,
        request: requestFor(cookie.value),
      })
    ).toEqual({
      intentId: "11111111-1111-4111-8111-111111111111",
      provider: "discord",
      userId: pendingUserId,
    });
    expect(
      readPendingDiscordLink({
        env,
        flow: "tourney",
        now: now + 1_000,
        request: requestFor(`${cookie.value}tampered`),
      })
    ).toBeNull();
    expect(
      readPendingDiscordLink({
        env,
        flow: "tourney",
        now: now + 15 * 60 * 1_000,
        request: requestFor(cookie.value),
      })
    ).toBeNull();
    expect(
      readPendingDiscordLink({
        env: { ...env, REF_SESSION_SECRET: env.TOURNEY_SESSION_SECRET },
        flow: "referral",
        now: now + 1_000,
        request: requestFor(cookie.value),
      })
    ).toBeNull();
  });

  test("merges the temporary Discord principal into the creator principal", async () => {
    const rpc = jest.fn((name) => {
      if (name === "roo_create_reauth_grant") {
        return Promise.resolve({ data: { created: true }, error: null });
      }
      return Promise.resolve({ data: { principal_id: primaryAccount.principal_id }, error: null });
    });
    const resolveAccount = jest.fn().mockResolvedValue(pendingAccount);

    const result = await linkPendingDiscordIdentity({
      adminClient: { rpc },
      pendingUser: {
        id: pendingUserId,
        identities: [{ provider: "discord" }],
      },
      primaryAccount,
      primaryUserId,
      resolveAccount,
    });

    expect(result).toEqual({
      linked: true,
      account: { principal_id: primaryAccount.principal_id },
      provider: "discord",
    });
    expect(resolveAccount).toHaveBeenCalledWith({
      userId: pendingUserId,
      adminClient: { rpc },
    });
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      "roo_create_reauth_grant",
      expect.objectContaining({
        p_purpose: "merge_account",
        p_user_id: primaryUserId,
      })
    );
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "roo_create_reauth_grant",
      expect.objectContaining({
        p_purpose: "merge_account",
        p_user_id: pendingUserId,
      })
    );
    expect(rpc).toHaveBeenNthCalledWith(
      3,
      "roo_merge_account_principals",
      expect.objectContaining({
        p_primary_grant_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        p_secondary_grant_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
  });

  test("merges the temporary Discord principal into an active Tourney principal", async () => {
    const rpc = jest.fn((name) => {
      if (name === "roo_create_reauth_grant") {
        return Promise.resolve({ data: { created: true }, error: null });
      }
      return Promise.resolve({
        data: { principal_id: tourneyAccount.principal_id },
        error: null,
      });
    });

    await expect(
      linkPendingDiscordIdentity({
        accountScope: "tourney",
        adminClient: { rpc },
        pendingUser: {
          id: pendingUserId,
          identities: [{ provider: "discord" }],
        },
        primaryAccount: tourneyAccount,
        primaryUserId,
        resolveAccount: jest.fn().mockResolvedValue(pendingAccount),
      })
    ).resolves.toEqual({
      linked: true,
      account: { principal_id: tourneyAccount.principal_id },
      provider: "discord",
    });
    expect(rpc).toHaveBeenLastCalledWith(
      "roo_merge_account_principals",
      expect.any(Object)
    );
  });

  test("rejects a session that does not hold the requested provider", async () => {
    const rpc = jest.fn();
    const result = await linkPendingDiscordIdentity({
      adminClient: { rpc },
      pendingUser: { id: pendingUserId, identities: [{ provider: "google" }] },
      primaryAccount,
      primaryUserId,
      provider: "discord",
    });

    expect(result).toEqual({ linked: false, reason: "discord_session_missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  test("rejects a Discord-only session when a Google link is requested", async () => {
    const rpc = jest.fn();
    const result = await linkPendingDiscordIdentity({
      adminClient: { rpc },
      pendingUser: { id: pendingUserId, identities: [{ provider: "discord" }] },
      primaryAccount,
      primaryUserId,
      provider: "google",
    });

    expect(result).toEqual({ linked: false, reason: "discord_session_missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  test("treats a previously merged Discord user as already linked", async () => {
    const rpc = jest.fn();
    const result = await linkPendingDiscordIdentity({
      adminClient: { rpc },
      pendingUser: {
        id: pendingUserId,
        identities: [{ provider: "discord" }],
      },
      primaryAccount,
      primaryUserId,
      resolveAccount: jest.fn().mockResolvedValue({
        principal_id: primaryAccount.principal_id,
        roles: [],
      }),
    });

    expect(result).toEqual({
      linked: true,
      account: primaryAccount,
      alreadyLinked: true,
      provider: "discord",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test("projects a tourney-owned Discord into the creator without merging", async () => {
    const rpc = jest
      .fn()
      .mockResolvedValue({ data: { linked: true, domain: "referral" }, error: null });
    const result = await linkPendingDiscordIdentity({
      adminClient: { rpc },
      pendingUser: {
        id: pendingUserId,
        identities: [{ provider: "discord", provider_id: "224466880022446688" }],
      },
      primaryAccount,
      primaryUserId,
      resolveAccount: jest.fn().mockResolvedValue({
        ...pendingAccount,
        roles: ["tourney_player"],
      }),
    });

    expect(result).toMatchObject({
      linked: true,
      crossDomain: true,
      provider: "discord",
    });
    expect(rpc).toHaveBeenCalledWith(
      "roo_link_domain_social_identity",
      expect.objectContaining({ p_domain: "referral", p_provider: "discord" })
    );
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain(
      "roo_merge_account_principals"
    );
  });

  test("projects a tourney-owned Google into the creator without merging", async () => {
    const rpc = jest
      .fn()
      .mockResolvedValue({ data: { linked: true, domain: "referral" }, error: null });
    const result = await linkPendingDiscordIdentity({
      adminClient: { rpc },
      pendingUser: {
        id: pendingUserId,
        identities: [
          {
            identity_data: { email: "Creator@Example.com" },
            provider: "google",
            provider_id: "109876543210987654321",
          },
        ],
      },
      primaryAccount,
      primaryUserId,
      provider: "google",
      resolveAccount: jest.fn().mockResolvedValue({
        ...pendingAccount,
        roles: ["tourney_player"],
      }),
    });

    expect(result).toMatchObject({
      linked: true,
      crossDomain: true,
      provider: "google",
      providerSubject: "109876543210987654321",
    });
    expect(rpc).toHaveBeenCalledWith("roo_link_domain_social_identity", {
      p_domain: "referral",
      p_metadata: { email: "Creator@Example.com" },
      p_principal_id: primaryAccount.principal_id,
      p_provider: "google",
      p_provider_email: "creator@example.com",
      p_provider_subject: "109876543210987654321",
    });
  });

  test("refuses a cross-domain link when the Discord subject is missing", async () => {
    const rpc = jest.fn();
    const result = await linkPendingDiscordIdentity({
      adminClient: { rpc },
      pendingUser: {
        id: pendingUserId,
        identities: [{ provider: "discord" }],
      },
      primaryAccount,
      primaryUserId,
      resolveAccount: jest.fn().mockResolvedValue({
        ...pendingAccount,
        roles: ["tourney_player"],
      }),
    });

    expect(result).toEqual({
      linked: false,
      reason: "discord_session_missing",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test("keeps a Google proof in its own cookie and refuses to read it as Discord", () => {
    const now = Date.parse("2026-07-27T08:00:00.000Z");
    const env = {
      NODE_ENV: "production",
      REF_SESSION_SECRET: "pending-link-test-secret",
    };
    const cookie = createPendingDiscordLinkCookie({
      env,
      intentId: "11111111-1111-4111-8111-111111111111",
      now,
      provider: "google",
      userId: pendingUserId,
    });
    const request = {
      headers: {
        cookie: `${cookie.name}=${encodeURIComponent(cookie.value)}`,
      },
    };

    expect(cookie.name).toBe("roo_pending_google_link");
    expect(
      readPendingDiscordLink({
        env,
        now: now + 1_000,
        provider: "google",
        request,
      })
    ).toEqual({
      intentId: "11111111-1111-4111-8111-111111111111",
      provider: "google",
      userId: pendingUserId,
    });
    // A held Google proof must never satisfy a Discord link.
    expect(
      readPendingDiscordLink({
        env,
        now: now + 1_000,
        provider: "discord",
        request,
      })
    ).toBeNull();
  });

  test("resolves whichever pending proof the browser actually holds", () => {
    const now = Date.parse("2026-07-27T08:00:00.000Z");
    const env = {
      NODE_ENV: "production",
      TOURNEY_SESSION_SECRET: "pending-tourney-link-test-secret",
    };
    const cookie = createPendingDiscordLinkCookie({
      env,
      flow: "tourney",
      intentId: "11111111-1111-4111-8111-111111111111",
      now,
      provider: "google",
      userId: pendingUserId,
    });
    const request = {
      headers: {
        cookie: `${cookie.name}=${encodeURIComponent(cookie.value)}`,
      },
    };

    // The request body asks for Discord, but only a Google proof is held, so
    // the Google proof is what gets resolved.
    expect(
      resolvePendingSocialLink({
        env,
        flow: "tourney",
        now: now + 1_000,
        provider: "discord",
        request,
      })
    ).toEqual({
      intentId: "11111111-1111-4111-8111-111111111111",
      provider: "google",
      userId: pendingUserId,
    });
    expect(
      resolvePendingSocialLink({
        env,
        flow: "tourney",
        now: now + 15 * 60 * 1_000,
        request,
      })
    ).toBeNull();
  });
});
