import fs from "node:fs";
import path from "node:path";

const loadStore = () => {
  jest.resetModules();
  return require("../server/tourney/playerStore.js");
};

const env = {
  NODE_ENV: "production",
  TOURNEY_SESSION_SECRET: "test_tourney_session_secret",
  TOURNEY_PLAYER_STORE_MODE: "memory",
  TOURNEY_ACCOUNTS_JSON: "[]",
  TOURNEY_TWITCH_PROFILE_LOOKUP: "0",
};

const approvers = [
  {
    username: "serviroo",
    email: "serviroo@rooindustries.com",
    role: "owner",
    version: "7",
  },
];

const registration = ({ discord, displayName, email }) => ({
  email,
  password: "player-password",
  passwordConfirm: "player-password",
  discord,
  displayName,
  battlenet: "Player#9876",
  rank: "Master",
  rolePlay: "Support",
  timezone: "Eastern Time (ET)",
  twitchUsername: discord.replace(/[^a-z0-9_]/gi, "").toLowerCase(),
  availableAug12: true,
  acceptedRules: true,
  acceptedCreatorEligibility: true,
  acceptedRooVisibility: true,
});

const addApprovedPlayer = async (store, details) => {
  const created = await store.createPendingTourneyPlayer({
    payload: registration(details),
    recipients: approvers,
    env,
  });
  const approveToken = created.tokens.find((token) => token.purpose === "approve");
  return store.applyRegistrationDecision({
    tokenHash: store.hashTourneyToken(approveToken.token),
    playerId: created.player.id,
    purpose: "approve",
    actorUsername: "serviroo",
    env,
  });
};

describe("tourney sign-in by roster display name", () => {
  afterEach(() => {
    const store = require("../server/tourney/playerStore.js");
    store.resetMemoryTourneyPlayerStoreForTests();
    jest.resetModules();
  });

  it("accepts the display name a player sees on the roster", async () => {
    const store = loadStore();
    const approved = await addApprovedPlayer(store, {
      discord: "r.e.p.l.e.x.e.d",
      displayName: "Bootchop",
      email: "bootchop@example.com",
    });

    // The generated username is unguessable, which is why the display name has to
    // work: discord name plus the first eight hex digits of its SHA-256.
    expect(approved.username).toMatch(/^r\.e\.p\.l\.e\.x\.e\.d-[0-9a-f]{8}$/);

    await expect(
      store.verifyTourneyPlayerCredentials({
        login: "Bootchop",
        password: "player-password",
        env,
      })
    ).resolves.toMatchObject({ ok: true, account: { username: approved.username } });

    await expect(
      store.verifyTourneyPlayerCredentials({
        login: "  bootchop  ",
        password: "player-password",
        env,
      })
    ).resolves.toMatchObject({ ok: true, account: { username: approved.username } });
  });

  it("rejects the display name but keeps the password wrong path intact", async () => {
    const store = loadStore();
    await addApprovedPlayer(store, {
      discord: "someone",
      displayName: "Bootchop",
      email: "bootchop@example.com",
    });

    await expect(
      store.verifyTourneyPlayerCredentials({
        login: "Bootchop",
        password: "wrong-password",
        env,
      })
    ).resolves.toMatchObject({ ok: false, account: null });
  });

  it("refuses to register a display name a live player already holds", async () => {
    const store = loadStore();
    await addApprovedPlayer(store, {
      discord: "vulture_one",
      displayName: "Vulture",
      email: "vulture-one@example.com",
    });

    // Case and surrounding space must not buy a way around it: the login lookup
    // compares lower(btrim(...)), so "vulture" and "Vulture" are one credential.
    await expect(
      addApprovedPlayer(store, {
        discord: "vulture_two",
        displayName: "  vulture ",
        email: "vulture-two@example.com",
      })
    ).rejects.toMatchObject({ status: 409, code: "TOURNEY_DISPLAY_NAME_TAKEN" });

    // The original holder still signs in by roster name.
    await expect(
      store.verifyTourneyPlayerCredentials({
        login: "Vulture",
        password: "player-password",
        env,
      })
    ).resolves.toMatchObject({ ok: true });
  });

  it("still refuses to resolve a duplicate that predates the constraint", async () => {
    const store = loadStore();
    // Rows created before uniqueness was enforced can still be ambiguous, and the
    // resolver must keep failing closed rather than picking one of them.
    await addApprovedPlayer(store, {
      discord: "vulture_one",
      displayName: "Vulture",
      email: "vulture-one@example.com",
    });
    const second = await addApprovedPlayer(store, {
      discord: "vulture_two",
      displayName: "Distinct Name",
      email: "vulture-two@example.com",
    });
    store.__setMemoryPlayerDisplayNameForTests(second.id, "vulture");

    await expect(
      store.verifyTourneyPlayerCredentials({
        login: "Vulture",
        password: "player-password",
        env,
      })
    ).resolves.toMatchObject({ ok: false, account: null });

    // Email still works for both of them.
    await expect(
      store.verifyTourneyPlayerCredentials({
        login: "vulture-two@example.com",
        password: "player-password",
        env,
      })
    ).resolves.toMatchObject({ ok: true });
  });

  it("does not let a withdrawn registration shadow a live player", async () => {
    const store = loadStore();
    const departed = await addApprovedPlayer(store, {
      discord: "hydro_old",
      displayName: "Hydro",
      email: "hydro-old@example.com",
    });
    await store.withdrawTourneyPlayer({
      playerId: departed.id,
      actorUsername: "serviroo",
      env,
    });
    // Only valid once the first holder has left: a withdrawn row must free the
    // name for the next player rather than reserving it forever.
    const live = await addApprovedPlayer(store, {
      discord: "hydro_new",
      displayName: "Hydro",
      email: "hydro-new@example.com",
    });

    await expect(
      store.verifyTourneyPlayerCredentials({
        login: "Hydro",
        password: "player-password",
        env,
      })
    ).resolves.toMatchObject({ ok: true, account: { username: live.username } });
  });

  it("sends a reset link for a unique display name and refuses a shared one", async () => {
    const store = loadStore();
    const solo = await addApprovedPlayer(store, {
      discord: "wint_a",
      displayName: "Winton Prime",
      email: "winton-a@example.com",
    });

    await expect(
      store.createTourneyResetToken({ login: "Winton Prime", env })
    ).resolves.toMatchObject({ player: { id: solo.id } });

    const second = await addApprovedPlayer(store, {
      discord: "wint_b",
      displayName: "Winton Second",
      email: "winton-b@example.com",
    });
    store.__setMemoryPlayerDisplayNameForTests(second.id, "winton prime");

    await expect(
      store.createTourneyResetToken({ login: "Winton Prime", env })
    ).resolves.toBeNull();
  });

  it("keeps a unique identifier ahead of a display name that repeats it", async () => {
    const store = loadStore();
    const owner = await addApprovedPlayer(store, {
      discord: "vaieia",
      displayName: "Val",
      email: "vaieia@example.com",
    });
    // A second player whose display name is the first player's Discord name must
    // not take over that identifier. Uniqueness is enforced against other display
    // names, not against discord handles, so this registration is allowed -- the
    // primary lookup is what has to keep the identifier with its owner.
    await addApprovedPlayer(store, {
      discord: "impostor",
      displayName: "vaieia",
      email: "impostor@example.com",
    });

    await expect(
      store.verifyTourneyPlayerCredentials({
        login: "vaieia",
        password: "player-password",
        env,
      })
    ).resolves.toMatchObject({ ok: true, account: { username: owner.username } });
  });
});

describe("display name sign-in migration", () => {
  const migration = fs.readFileSync(
    path.resolve(
      "supabase/migrations/20260726114500_resolve_tourney_alias_by_display_name.sql"
    ),
    "utf8"
  );

  test("keeps exact alias matches ahead of the display name", () => {
    const aliasClause = migration.indexOf("alias.normalized_value = v_needle");
    const displayClause = migration.indexOf("player.display_name");
    expect(aliasClause).toBeGreaterThan(-1);
    expect(displayClause).toBeGreaterThan(aliasClause);
  });

  test("refuses an ambiguous display name instead of choosing one", () => {
    expect(migration).toContain("if v_matches <> 1 or v_player_id is null then");
    expect(migration).toContain("status in ('approved', 'pending')");
  });

  test("tolerates the roster table not existing yet", () => {
    expect(migration).toContain(
      "if to_regclass('tourney.tourney_players') is null then"
    );
  });

  test("never lets a roster read failure break username and email sign-in", () => {
    expect(migration).toContain("exception when others then\n    return null;");
  });

  test("grants the resolver to service_role only", () => {
    expect(migration).toContain(
      "grant execute on function public.roo_resolve_tourney_account_alias(text)\n  to service_role;"
    );
    expect(migration).not.toMatch(/to\s+(anon|authenticated)\b/);
  });
});

describe("reset link lifetime", () => {
  const loadEmail = () => {
    jest.resetModules();
    return require("../server/tourney/email.js");
  };

  test("mints a reset token that lasts 24 hours", () => {
    const store = loadStore();
    expect(store.RESET_TOKEN_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("the email states the window the token actually has", () => {
    const source = fs.readFileSync(
      path.resolve("src/server/tourney/email.js"),
      "utf8"
    );
    // A hardcoded duration silently lies the moment the TTL changes, and the queue
    // can deliver long after the token was minted.
    expect(source).not.toContain("This link expires in 1 hour.</p>");
    expect(source).toContain("describeResetWindow(expiresAt)");
  });

  test("describes a day-long window rather than promising an hour", () => {
    const { __describeResetWindowForTests: describe_ } = loadEmail();
    const inADay = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(describe_(inADay)).toBe("This link expires in 24 hours.");
    const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    expect(describe_(inTwoHours)).toBe("This link expires in 2 hours.");
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    expect(describe_(past)).toBe("This link has expired. Request a new one.");
    expect(describe_("")).toBe("This link expires soon.");
  });
});

describe("roster name uniqueness migration", () => {
  const migration = fs.readFileSync(
    path.resolve(
      "supabase/migrations/20260726193000_unique_tourney_display_name_for_login.sql"
    ),
    "utf8"
  );

  test("enforces uniqueness the same way the login lookup compares", () => {
    expect(migration).toContain("lower(btrim(display_name))");
    expect(migration).toContain("create unique index if not exists");
  });

  test("only constrains the statuses that can sign in", () => {
    expect(migration).toContain("where status in ('approved', 'pending')");
  });

  test("leaves players without a roster name alone", () => {
    expect(migration).toContain("btrim(display_name) <> ''");
  });
});

describe("plain username sign-in migration", () => {
  const migration = fs.readFileSync(
    path.resolve(
      "supabase/migrations/20260727120000_accept_base_tourney_username_at_login.sql"
    ),
    "utf8"
  );

  test("registers the plain username as a real alias rather than trimming at lookup", () => {
    // Stripping the suffix inside the resolver would merge two identifier spaces and
    // could match a player whose chosen name genuinely ends in eight hex characters.
    expect(migration).toContain("v_base_username");
    expect(migration).toContain("regexp_replace(v_username, '-[0-9a-f]{8}$', '')");
    expect(migration).toContain("'tourney_username', v_base_username");
  });

  test("claims the plain username separately so a collision cannot abort the import", () => {
    const pairInsert = migration.indexOf("'tourney_email', v_login_email");
    const baseInsert = migration.indexOf("'tourney_username', v_base_username");
    expect(pairInsert).toBeGreaterThan(-1);
    expect(baseInsert).toBeGreaterThan(pairInsert);
    expect(migration).toContain(
      "if v_base_username is not null and v_base_username <> v_username then"
    );
  });

  test("never hands one player another player's login", () => {
    // (alias_type, normalized_value) is unique, and the guarded ON CONFLICT leaves a
    // row owned by someone else untouched instead of stealing it.
    expect(migration).toContain(
      "where accounts.login_aliases.user_id = excluded.user_id"
    );
  });

  test("still creates the role and profile rows sign-in is gated on", () => {
    // A resolving alias is not enough: authenticateSupabaseAccount also requires a
    // tourney_player role and an active profile, so an import missing either one
    // produces an account that resolves and then fails to log in.
    expect(migration).toContain("insert into accounts.account_roles");
    expect(migration).toContain("'tourney_player'");
    expect(migration).toContain("insert into public.profiles");
  });

  test("rejects a base value the alias column could not store", () => {
    expect(migration).toContain("char_length(v_base_username) > 254");
  });
});
