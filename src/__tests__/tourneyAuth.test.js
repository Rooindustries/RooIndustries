const bcrypt = require("bcryptjs");

const loadAuth = () => {
  jest.resetModules();
  return require("../server/tourney/auth.js");
};

const buildEnv = (accounts, overrides = {}) => ({
  NODE_ENV: "production",
  TOURNEY_SESSION_SECRET: "test_tourney_session_secret",
  TOURNEY_ACCOUNTS_JSON: JSON.stringify(accounts),
  ...overrides,
});

describe("tourney auth", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("parses active viewer, caster, and owner accounts from server env JSON", () => {
    const auth = loadAuth();
    const accounts = auth.parseTourneyAccounts(
      JSON.stringify({
        accounts: [
          {
            username: " CasterOne ",
            email: "Caster@Example.com ",
            role: "CASTER",
            passwordHash: "hash",
            active: true,
            version: 3,
          },
          {
            username: " OwnerOne ",
            role: "OWNER",
            passwordHash: "owner-hash",
            active: true,
            version: 4,
          },
          {
            username: "bad",
            role: "admin",
            passwordHash: "hash",
          },
        ],
      })
    );

    expect(accounts).toEqual([
      {
        username: "casterone",
        email: "caster@example.com",
        role: "caster",
        passwordHash: "hash",
        active: true,
        version: "3",
      },
      {
        username: "ownerone",
        role: "owner",
        passwordHash: "owner-hash",
        active: true,
        version: "4",
      },
    ]);
  });

  test("verifies a valid password and rejects inactive users", async () => {
    const auth = loadAuth();
    const activeHash = await bcrypt.hash("correct-password", 4);
    const inactiveHash = await bcrypt.hash("inactive-password", 4);
    const env = buildEnv([
      {
        username: "viewer1",
        role: "viewer",
        passwordHash: activeHash,
        active: true,
        version: "1",
      },
      {
        username: "caster1",
        role: "caster",
        passwordHash: inactiveHash,
        active: false,
        version: "1",
      },
    ]);

    await expect(
      auth.verifyTourneyCredentials({
        username: "VIEWER1",
        password: "correct-password",
        env,
      })
    ).resolves.toMatchObject({
      ok: true,
      account: { username: "viewer1", role: "viewer" },
    });

    await expect(
      auth.verifyTourneyCredentials({
        username: "caster1",
        password: "inactive-password",
        env,
      })
    ).resolves.toMatchObject({ ok: false, account: null });
  });

  test("prefers persisted account store over server env accounts", async () => {
    const auth = loadAuth();
    const envHash = await bcrypt.hash("env-password", 4);
    const persistedHash = await bcrypt.hash("persisted-password", 4);
    const env = buildEnv([
      {
        username: "viewer1",
        role: "viewer",
        passwordHash: envHash,
        active: true,
        version: "1",
      },
    ]);
    const readPersistedAccountsJson = jest.fn(async () =>
      JSON.stringify([
        {
          username: "viewer1",
          role: "viewer",
          passwordHash: persistedHash,
          active: true,
          version: "2",
        },
      ])
    );

    await expect(
      auth.verifyTourneyCredentials({
        username: "viewer1",
        password: "env-password",
        env,
        readPersistedAccountsJson,
      })
    ).resolves.toMatchObject({ ok: false, account: null });

    await expect(
      auth.verifyTourneyCredentials({
        username: "viewer1",
        password: "persisted-password",
        env,
        readPersistedAccountsJson,
      })
    ).resolves.toMatchObject({
      ok: true,
      account: { username: "viewer1", role: "viewer", version: "2" },
    });
  });

  test("creates sessions that fail closed after account version changes", () => {
    const auth = loadAuth();
    const baseAccount = {
      username: "caster1",
      role: "caster",
      passwordHash: "hash",
      active: true,
      version: "1",
    };
    const env = buildEnv([baseAccount]);
    const token = auth.createTourneySessionToken({
      account: baseAccount,
      env,
      maxAgeSeconds: 60,
    });

    expect(auth.readTourneySession({ token, env })).toMatchObject({
      username: "caster1",
      role: "caster",
    });

    expect(
      auth.readTourneySession({
        token,
        env: buildEnv([{ ...baseAccount, version: "2" }]),
      })
    ).toBeNull();
  });

  test("reads sessions against persisted account versions", async () => {
    const auth = loadAuth();
    const baseAccount = {
      username: "caster1",
      role: "caster",
      passwordHash: "hash",
      active: true,
      version: "1",
    };
    const env = buildEnv([baseAccount]);
    const token = auth.createTourneySessionToken({
      account: baseAccount,
      env,
      maxAgeSeconds: 60,
    });

    await expect(
      auth.readTourneySessionFromStore({
        token,
        env,
        readPersistedAccountsJson: async () =>
          JSON.stringify([{ ...baseAccount, version: "2" }]),
      })
    ).resolves.toBeNull();
  });

  test("creates valid owner sessions", () => {
    const auth = loadAuth();
    const owner = {
      username: "owner1",
      role: "owner",
      passwordHash: "hash",
      active: true,
      version: "1",
    };
    const env = buildEnv([owner]);
    const token = auth.createTourneySessionToken({
      account: owner,
      env,
      maxAgeSeconds: 60,
    });

    expect(auth.readTourneySession({ token, env })).toMatchObject({
      username: "owner1",
      role: "owner",
    });
  });

  test("builds owner-managed account updates without changing owner accounts", async () => {
    const auth = loadAuth();
    const owner = {
      username: "owner1",
      role: "owner",
      passwordHash: "owner-hash",
      active: true,
      version: "1",
    };
    const accounts = await auth.buildUpdatedTourneyAccounts({
      action: "upsert",
      username: "CasterOne",
      role: "caster",
      password: "new-password",
      accounts: [owner],
    });
    const caster = accounts.find((account) => account.username === "casterone");

    expect(caster).toMatchObject({
      role: "caster",
      active: true,
      version: "1",
    });
    await expect(bcrypt.compare("new-password", caster.passwordHash)).resolves.toBe(true);
    expect(auth.summarizeTourneyAccounts(accounts)).toEqual([
      {
        username: "casterone",
        email: "",
        role: "caster",
        active: true,
        version: "1",
      },
      {
        username: "owner1",
        email: "",
        role: "owner",
        active: true,
        version: "1",
      },
    ]);
    expect(auth.renderTourneyAccountsJson(accounts)).toContain("\"role\": \"owner\"");

    await expect(
      auth.buildUpdatedTourneyAccounts({
        action: "disable",
        username: "owner1",
        accounts,
      })
    ).rejects.toThrow("Owner accounts can only be changed from server env.");
  });

  test("changes existing managed account passwords with a new hash and version", async () => {
    const auth = loadAuth();
    const originalHash = await bcrypt.hash("old-password", 4);
    const account = {
      username: "caster1",
      role: "caster",
      passwordHash: originalHash,
      active: true,
      version: "4",
    };
    const env = buildEnv([account]);
    const staleToken = auth.createTourneySessionToken({
      account,
      env,
      maxAgeSeconds: 60,
    });
    const accounts = await auth.buildUpdatedTourneyAccounts({
      action: "change-password",
      username: "caster1",
      password: "new-password",
      accounts: [account],
    });
    const updated = accounts[0];

    expect(updated).toMatchObject({
      username: "caster1",
      role: "caster",
      active: true,
      version: "5",
    });
    expect(updated.passwordHash).not.toBe(originalHash);
    expect(updated.passwordHash).toMatch(/^\$2[aby]\$/);
    await expect(bcrypt.compare("new-password", updated.passwordHash)).resolves.toBe(true);
    await expect(bcrypt.compare("old-password", updated.passwordHash)).resolves.toBe(false);
    expect(auth.readTourneySession({ token: staleToken, env: buildEnv(accounts) })).toBeNull();
  });

  test("merges yukari bootstrap without overwriting persisted owner passwords", async () => {
    const auth = loadAuth();
    const envOwnerHash = await bcrypt.hash("env-owner-password", 4);
    const persistedOwnerHash = await bcrypt.hash("persisted-owner-password", 4);
    const yukariHash = await bcrypt.hash("caster-temp-password", 4);
    const env = buildEnv(
      [
        {
          username: "serviroo",
          role: "owner",
          passwordHash: envOwnerHash,
          active: true,
          version: "1",
        },
      ],
      {
        TOURNEY_BOOTSTRAP_ACCOUNTS_JSON: JSON.stringify([
          {
            username: "yukari",
            email: "yukariipoi@gmail.com",
            role: "caster",
            passwordHash: yukariHash,
            active: true,
            version: "1",
          },
        ]),
      }
    );
    const readPersistedAccountsJson = jest.fn(async () =>
      JSON.stringify([
        {
          username: "serviroo",
          role: "owner",
          passwordHash: persistedOwnerHash,
          active: true,
          version: "7",
        },
      ])
    );

    const accounts = await auth.readEffectiveTourneyAccounts({
      env,
      readPersistedAccountsJson,
    });

    expect(accounts.map((account) => account.username)).toEqual([
      "serviroo",
      "yukari",
    ]);
    await expect(
      auth.verifyTourneyCredentials({
        username: "serviroo",
        password: "persisted-owner-password",
        env,
        readPersistedAccountsJson,
      })
    ).resolves.toMatchObject({
      ok: true,
      account: { username: "serviroo", role: "owner", version: "7" },
    });
    await expect(
      auth.verifyTourneyCredentials({
        username: "serviroo",
        password: "env-owner-password",
        env,
        readPersistedAccountsJson,
      })
    ).resolves.toMatchObject({ ok: false, account: null });
    await expect(
      auth.verifyTourneyCredentials({
        username: "yukari",
        password: "caster-temp-password",
        env,
        readPersistedAccountsJson,
      })
    ).resolves.toMatchObject({
      ok: true,
      account: {
        username: "yukari",
        email: "yukariipoi@gmail.com",
        role: "caster",
      },
    });

    const rotatedAccounts = await auth.buildUpdatedTourneyAccounts({
      action: "change-password",
      username: "yukari",
      actorUsername: "yukari",
      password: "new-yukari-password",
      accounts,
    });
    const rotatedOwner = rotatedAccounts.find(
      (account) => account.username === "serviroo"
    );
    const rotatedYukari = rotatedAccounts.find(
      (account) => account.username === "yukari"
    );

    expect(rotatedOwner.passwordHash).toBe(persistedOwnerHash);
    expect(rotatedOwner.version).toBe("7");
    expect(rotatedYukari.version).toBe("2");
    expect(rotatedYukari.passwordHash).not.toBe(yukariHash);
    await expect(
      bcrypt.compare("new-yukari-password", rotatedYukari.passwordHash)
    ).resolves.toBe(true);
  });

  test("allows an owner to rotate only their own owner password", async () => {
    const auth = loadAuth();
    const originalHash = await bcrypt.hash("old-owner-password", 4);
    const owner = {
      username: "serviroo",
      role: "owner",
      passwordHash: originalHash,
      active: true,
      version: "7",
    };
    const otherOwner = {
      username: "backup-owner",
      role: "owner",
      passwordHash: "backup-hash",
      active: true,
      version: "1",
    };

    const accounts = await auth.buildUpdatedTourneyAccounts({
      action: "change-password",
      username: "serviroo",
      actorUsername: "serviroo",
      password: "new-owner-password",
      accounts: [owner, otherOwner],
    });
    const updatedOwner = accounts.find((account) => account.username === "serviroo");

    expect(updatedOwner).toMatchObject({
      username: "serviroo",
      role: "owner",
      active: true,
      version: "8",
    });
    expect(updatedOwner.passwordHash).not.toBe(originalHash);
    expect(updatedOwner.passwordHash).toMatch(/^\$2[aby]\$/);
    await expect(
      bcrypt.compare("new-owner-password", updatedOwner.passwordHash)
    ).resolves.toBe(true);

    await expect(
      auth.buildUpdatedTourneyAccounts({
        action: "change-password",
        username: "backup-owner",
        actorUsername: "serviroo",
        password: "new-backup-password",
        accounts: [owner, otherOwner],
      })
    ).rejects.toThrow("Owner accounts can only change their own password.");
  });

  test("rejects tampered and expired session cookies", () => {
    const auth = loadAuth();
    const account = {
      username: "viewer1",
      role: "viewer",
      passwordHash: "hash",
      active: true,
      version: "1",
    };
    const env = buildEnv([account]);
    const token = auth.createTourneySessionToken({
      account,
      env,
      maxAgeSeconds: 1,
    });

    expect(auth.readTourneySession({ token: `${token}x`, env })).toBeNull();
    expect(
      auth.readTourneySession({
        token,
        env,
        nowSeconds: Math.floor(Date.now() / 1000) + 5,
      })
    ).toBeNull();
  });

  test("creates admin password reset tokens that are purpose and version bound", () => {
    const auth = loadAuth();
    const account = {
      username: "yukari",
      email: "yukariipoi@gmail.com",
      role: "caster",
      passwordHash: "hash",
      active: true,
      version: "3",
    };
    const env = buildEnv([account]);
    const token = auth.createTourneyPasswordResetToken({
      account,
      env,
      maxAgeSeconds: 60,
    });

    expect(auth.readTourneyPasswordReset({ token, env })).toMatchObject({
      username: "yukari",
      role: "caster",
      version: "3",
    });
    expect(auth.readTourneySession({ token, env })).toBeNull();
    expect(auth.readTourneyPasswordReset({ token: `${token}x`, env })).toBeNull();
    expect(
      auth.readTourneyPasswordReset({
        token,
        env: buildEnv([{ ...account, version: "4" }]),
      })
    ).toBeNull();
    expect(
      auth.readTourneyPasswordReset({
        token,
        env,
        nowSeconds: Math.floor(Date.now() / 1000) + 120,
      })
    ).toBeNull();
  });

  test("rate limits repeated login attempts by key", () => {
    const auth = loadAuth();
    const key = `test-key-${Date.now()}`;

    expect(auth.checkTourneyRateLimit({ key, max: 2 }).ok).toBe(true);
    expect(auth.checkTourneyRateLimit({ key, max: 2 }).ok).toBe(true);
    expect(auth.checkTourneyRateLimit({ key, max: 2 }).ok).toBe(false);
  });

  test("keeps production cookies secure unless local verification overrides it", () => {
    const auth = loadAuth();

    expect(auth.getTourneyCookieOptions({ NODE_ENV: "production" })).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: auth.TOURNEY_SESSION_MAX_AGE_SECONDS,
    });
    expect(
      auth.getTourneyCookieOptions({
        NODE_ENV: "production",
        TOURNEY_ALLOW_INSECURE_COOKIE: "1",
      })
    ).toMatchObject({ secure: false });
    expect(
      auth.getTourneyCookieOptions(
        { NODE_ENV: "production" },
        { maxAgeSeconds: auth.TOURNEY_REMEMBERED_SESSION_MAX_AGE_SECONDS }
      )
    ).toMatchObject({
      maxAge: auth.TOURNEY_REMEMBERED_SESSION_MAX_AGE_SECONDS,
    });
  });
});
