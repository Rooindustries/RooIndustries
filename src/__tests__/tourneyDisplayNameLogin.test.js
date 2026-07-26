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

  it("refuses a display name shared by two live players", async () => {
    const store = loadStore();
    await addApprovedPlayer(store, {
      discord: "vulture_one",
      displayName: "Vulture",
      email: "vulture-one@example.com",
    });
    await addApprovedPlayer(store, {
      discord: "vulture_two",
      displayName: "vulture",
      email: "vulture-two@example.com",
    });

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
    const live = await addApprovedPlayer(store, {
      discord: "hydro_new",
      displayName: "Hydro",
      email: "hydro-new@example.com",
    });
    await store.withdrawTourneyPlayer({
      playerId: departed.id,
      actorUsername: "serviroo",
      env,
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

    await addApprovedPlayer(store, {
      discord: "wint_b",
      displayName: "winton prime",
      email: "winton-b@example.com",
    });

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
    // not take over that identifier.
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
