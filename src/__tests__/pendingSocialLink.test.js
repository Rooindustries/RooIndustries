import { linkPendingDiscordIdentity } from "../server/supabase/pendingSocialLink";

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

describe("pending Discord referral linking", () => {
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

  test("rejects a session without a Discord identity", async () => {
    const rpc = jest.fn();
    const result = await linkPendingDiscordIdentity({
      adminClient: { rpc },
      pendingUser: { id: pendingUserId, identities: [{ provider: "google" }] },
      primaryAccount,
      primaryUserId,
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
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test("does not merge another domain account into the creator", async () => {
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
      reason: "discord_account_not_linkable",
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});
