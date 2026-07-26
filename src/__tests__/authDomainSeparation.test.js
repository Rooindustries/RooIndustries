import fs from "node:fs";
import path from "node:path";
import { linkPendingDiscordIdentity } from "../server/supabase/pendingSocialLink";

const primaryUserId = "10000000-0000-4000-8000-000000000001";
const pendingUserId = "20000000-0000-4000-8000-000000000002";
const discordSubject = "224466880022446688";

const tourneyPrimaryAccount = {
  principal_id: "30000000-0000-4000-8000-000000000003",
  roles: ["tourney_player"],
  status: "active",
  tourney_active: true,
  tourney_username: "player-one",
};

const referralPrimaryAccount = {
  creator_active: true,
  principal_id: "30000000-0000-4000-8000-000000000003",
  roles: ["creator"],
};

// The Discord account signs in to this person's referral account.
const creatorPendingAccount = {
  creator_active: true,
  creator_legacy_sanity_id: "referral.abc",
  principal_id: "40000000-0000-4000-8000-000000000004",
  roles: ["creator"],
};

const tourneyPendingAccount = {
  principal_id: "40000000-0000-4000-8000-000000000004",
  roles: ["tourney_player"],
  tourney_legacy_player_id: "player-two",
};

const discordUser = (overrides = {}) => ({
  id: pendingUserId,
  email: "player@example.com",
  identities: [
    {
      provider: "discord",
      provider_id: discordSubject,
      identity_data: { email: "player@example.com", user_name: "Winton" },
    },
  ],
  ...overrides,
});

describe("referral and tourney Discord linking are separate", () => {
  test("links a referral-owned Discord to a tourney account without merging principals", async () => {
    const rpc = jest
      .fn()
      .mockResolvedValue({ data: { linked: true, domain: "tourney" }, error: null });

    const result = await linkPendingDiscordIdentity({
      accountScope: "tourney",
      adminClient: { rpc },
      pendingUser: discordUser(),
      primaryAccount: tourneyPrimaryAccount,
      primaryUserId,
      resolveAccount: jest.fn().mockResolvedValue(creatorPendingAccount),
    });

    expect(result).toMatchObject({
      linked: true,
      crossDomain: true,
      providerSubject: discordSubject,
    });

    // The projected tourney-domain link is what the guild role resolves against.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "roo_link_domain_discord_identity",
      expect.objectContaining({
        p_principal_id: tourneyPrimaryAccount.principal_id,
        p_domain: "tourney",
        p_provider_subject: discordSubject,
      })
    );

    // Merging would soft-delete the referral principal. It must never happen.
    const calledRpcs = rpc.mock.calls.map(([name]) => name);
    expect(calledRpcs).not.toContain("roo_merge_account_principals");
    expect(calledRpcs).not.toContain("roo_create_reauth_grant");
  });

  test("still refuses a Discord that already owns an account in the same domain", async () => {
    const rpc = jest.fn();

    await expect(
      linkPendingDiscordIdentity({
        accountScope: "tourney",
        adminClient: { rpc },
        pendingUser: discordUser(),
        primaryAccount: tourneyPrimaryAccount,
        primaryUserId,
        resolveAccount: jest.fn().mockResolvedValue(tourneyPendingAccount),
      })
    ).resolves.toEqual({ linked: false, reason: "discord_account_not_linkable" });

    expect(rpc).not.toHaveBeenCalled();
  });

  test("links a tourney-owned Discord into a referral account", async () => {
    const rpc = jest
      .fn()
      .mockResolvedValue({ data: { linked: true, domain: "referral" }, error: null });

    await expect(
      linkPendingDiscordIdentity({
        accountScope: "referral",
        adminClient: { rpc },
        pendingUser: discordUser(),
        primaryAccount: referralPrimaryAccount,
        primaryUserId,
        resolveAccount: jest.fn().mockResolvedValue(tourneyPendingAccount),
      })
    ).resolves.toMatchObject({
      linked: true,
      crossDomain: true,
      providerSubject: discordSubject,
    });

    expect(rpc).toHaveBeenCalledWith(
      "roo_link_domain_discord_identity",
      expect.objectContaining({
        p_principal_id: referralPrimaryAccount.principal_id,
        p_domain: "referral",
        p_provider_subject: discordSubject,
      })
    );
    const calledRpcs = rpc.mock.calls.map(([name]) => name);
    expect(calledRpcs).not.toContain("roo_merge_account_principals");
  });

  test("reports a refusal returned in the payload instead of reading it as linked", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: {
        linked: false,
        reason: "another_discord_already_linked",
        domain: "referral",
      },
      error: null,
    });

    await expect(
      linkPendingDiscordIdentity({
        accountScope: "referral",
        adminClient: { rpc },
        pendingUser: discordUser(),
        primaryAccount: referralPrimaryAccount,
        primaryUserId,
        resolveAccount: jest.fn().mockResolvedValue(tourneyPendingAccount),
      })
    ).resolves.toEqual({
      linked: false,
      reason: "another_discord_already_linked",
    });
  });

  test("reports a missing Discord subject rather than linking a blank identity", async () => {
    const rpc = jest.fn();

    await expect(
      linkPendingDiscordIdentity({
        accountScope: "tourney",
        adminClient: { rpc },
        pendingUser: discordUser({
          identities: [{ provider: "discord", identity_data: {} }],
        }),
        primaryAccount: tourneyPrimaryAccount,
        primaryUserId,
        resolveAccount: jest.fn().mockResolvedValue(creatorPendingAccount),
      })
    ).resolves.toEqual({ linked: false, reason: "discord_session_missing" });

    expect(rpc).not.toHaveBeenCalled();
  });

  test("surfaces a database error rather than reporting a link", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { code: "23505", message: "Discord identity belongs to another account" },
    });

    await expect(
      linkPendingDiscordIdentity({
        accountScope: "tourney",
        adminClient: { rpc },
        pendingUser: discordUser(),
        primaryAccount: tourneyPrimaryAccount,
        primaryUserId,
        resolveAccount: jest.fn().mockResolvedValue(creatorPendingAccount),
      })
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("identity link domain migration", () => {
  const migration = fs.readFileSync(
    path.resolve(
      "supabase/migrations/20260726051500_scope_identity_links_by_domain.sql"
    ),
    "utf8"
  );

  test("scopes uniqueness by domain instead of dropping it", () => {
    for (const required of [
      "set lock_timeout = '5s';",
      "set statement_timeout = '120s';",
      "add column if not exists domain text not null default 'referral'",
      "drop constraint if exists identity_links_provider_provider_subject_key",
      "on accounts.identity_links (domain, provider, provider_subject)",
      "on accounts.identity_links (principal_id, domain, provider)",
    ]) {
      expect(migration).toContain(required);
    }
  });

  test("keeps the single-argument reconciler so existing callers do not break", () => {
    expect(migration).toContain(
      "create or replace function public.roo_reconcile_auth_identity_links(p_user_id uuid)"
    );
    expect(migration).toContain(
      "select public.roo_reconcile_auth_identity_links(p_user_id, null::text)"
    );
  });

  test("never garbage-collects a cross-domain link for lacking auth backing", () => {
    expect(migration).toContain("and projected.backend_owner = 'supabase'");
    expect(migration).toContain("'tourney_link'");
  });

  test("grants the new functions to service_role only", () => {
    for (const required of [
      "revoke all on function public.roo_link_tourney_discord_identity(uuid, text, text, jsonb)\n  from public, anon, authenticated;",
      "grant execute on function public.roo_link_tourney_discord_identity(uuid, text, text, jsonb)\n  to service_role;",
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).not.toMatch(/to\s+(anon|authenticated)\b/);
  });
});

describe("per-domain Discord link migration", () => {
  const migration = fs.readFileSync(
    path.resolve(
      "supabase/migrations/20260726120000_link_discord_identity_per_domain.sql"
    ),
    "utf8"
  );

  test("resolves the owning account from the domain being linked", () => {
    for (const required of [
      "v_domain not in ('referral', 'tourney')",
      "from accounts.tourney_accounts tourney",
      "from accounts.creator_profiles creator",
      "v_domain || '_link', v_domain",
    ]) {
      expect(migration).toContain(required);
    }
  });

  test("reports an existing different Discord instead of hitting the unique index", () => {
    expect(migration).toContain("and link.provider_subject <> v_subject");
    expect(migration).toContain("'another_discord_already_linked'");
  });

  test("marks every outcome with an explicit linked flag", () => {
    expect(migration).toContain("'linked', true");
    expect(migration).toContain("'linked', false");
  });

  test("keeps the tourney signature working through a wrapper", () => {
    expect(migration).toContain(
      "create or replace function public.roo_link_tourney_discord_identity("
    );
    expect(migration).toContain(
      "p_principal_id, 'tourney', p_provider_subject, p_provider_email, p_metadata"
    );
  });

  test("grants the new function to service_role only", () => {
    expect(migration).toContain(
      "grant execute on function public.roo_link_domain_discord_identity(uuid, text, text, text, jsonb)\n  to service_role;"
    );
    expect(migration).not.toMatch(/to\s+(anon|authenticated)\b/);
  });
});

describe("cross-domain link owner constraint", () => {
  const migration = fs.readFileSync(
    path.resolve(
      "supabase/migrations/20260726143000_allow_cross_domain_link_owners.sql"
    ),
    "utf8"
  );
  const linkMigration = fs.readFileSync(
    path.resolve(
      "supabase/migrations/20260726120000_link_discord_identity_per_domain.sql"
    ),
    "utf8"
  );

  // The linker writes backend_owner = '<domain>_link'; the original check only
  // admitted 'sanity' and 'supabase', so every cross-domain link aborted with
  // accounts_identity_links_backend_owner_check.
  test("admits the owner values the linker actually writes", () => {
    expect(linkMigration).toContain("v_domain || '_link', v_domain");
    for (const owner of ["tourney_link", "referral_link"]) {
      expect(migration).toContain(`'${owner}'`);
    }
  });

  test("keeps the original import owners", () => {
    for (const owner of ["sanity", "supabase"]) {
      expect(migration).toContain(`'${owner}'`);
    }
  });

  test("replaces the constraint rather than leaving it dropped", () => {
    expect(migration).toContain(
      "drop constraint if exists accounts_identity_links_backend_owner_check"
    );
    expect(migration).toContain(
      "add constraint accounts_identity_links_backend_owner_check"
    );
    expect(migration).toMatch(/check \(backend_owner in \(/);
  });
});
