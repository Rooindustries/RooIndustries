const mockRunTourneyTransaction = jest.fn();
const mockResolveTourneyStorePolicy = jest.fn();

jest.mock("../server/tourney/sqlClient.js", () => ({
  getTourneySql: jest.fn(),
  runTourneyTransaction: (...args) => mockRunTourneyTransaction(...args),
}));

jest.mock("../server/tourney/discordConfig.js", () => ({
  getTourneyDiscordRoleConfig: () => ({ enabled: true, guildId: "123456789" }),
}));

jest.mock("../server/tourney/externalOperations.js", () => ({
  enqueueTourneyExternalOperation: jest.fn(),
  enqueueTourneyIdentityUnlinkOperation: jest.fn(),
  rearmTourneyDiscordOperationWithAccessToken: jest.fn(),
  saveTourneyDiscordOperationAccessToken: jest.fn(),
  supersedeQueuedDiscordOperationsForCommand: jest.fn(),
}));

jest.mock("../server/tourney/store.js", () => ({
  executeTourneyCommand: jest.fn(),
  resolveTourneyStorePolicy: (...args) => mockResolveTourneyStorePolicy(...args),
}));

const {
  projectTourneyDiscordOAuthDesiredState,
} = require("../server/tourney/discordDesiredState.js");

const env = {
  NODE_ENV: "test",
  TOURNEY_DATABASE_MODE: "supabase",
};
const intentId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const principalId = "33333333-3333-4333-8333-333333333333";
const operationKey = "discord-membership-signup-recovery";

const configureSql = ({
  action = "signup",
  flow = "tourney",
  registered = false,
  secretLive = true,
} = {}) => {
  const sql = jest.fn((strings) => {
    const query = Array.isArray(strings) ? strings.join(" ") : String(strings || "");
    if (query.includes("set_config")) return Promise.resolve([]);
    if (query.includes("update tourney.external_operations set")) {
      return Promise.resolve([{ operation_key: operationKey }]);
    }
    if (query.includes("from accounts.oauth_intents")) {
      return Promise.resolve([{
        action,
        claimed_user_id: userId,
        expires_at: "2026-07-14T10:15:00.000Z",
        flow,
        principal_id: principalId,
        provider: "discord",
        status: "completed",
        target_user_id: null,
      }]);
    }
    if (query.includes("from accounts.tourney_accounts account") &&
        query.includes("exists(")) {
      return Promise.resolve(registered ? [{
        account_user_id: userId,
        player_id: null,
      }] : []);
    }
    if (query.includes("from tourney.external_operation_secrets")) {
      return Promise.resolve(secretLive
        ? [{ expires_at: "2026-07-14T11:31:00.000Z" }]
        : []);
    }
    if (query.includes("join accounts.identity_links identity")) {
      return Promise.resolve([{
        account_user_id: userId,
        discord_user_id: "987654321",
        identity_metadata: { username: "new-player" },
        player_id: null,
      }]);
    }
    throw new Error(`Unexpected SQL in Discord signup recovery test: ${query}`);
  });
  mockRunTourneyTransaction.mockImplementation(({ callback }) => callback(sql));
  return sql;
};

describe("delayed Tourney Discord OAuth projection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date("2026-07-14T10:31:00.000Z"));
    mockResolveTourneyStorePolicy.mockReturnValue({
      generation: 1,
      mirrorEnabled: true,
      primaryBackend: "supabase",
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("remains retryable after the 15-minute intent window and applies after registration", async () => {
    configureSql({ registered: false });

    await expect(projectTourneyDiscordOAuthDesiredState({
      claimedUserId: userId,
      commandId: `discord-oauth:${intentId}:${userId}`,
      env,
      intentId,
      operationKey,
      userId,
    })).rejects.toMatchObject({
      code: "TOURNEY_DISCORD_ACCOUNT_PROJECTION_PENDING",
      retryAfterMs: 300_000,
    });

    configureSql({ registered: true });

    await expect(projectTourneyDiscordOAuthDesiredState({
      claimedUserId: userId,
      commandId: `discord-oauth:${intentId}:${userId}`,
      env,
      intentId,
      operationKey,
      userId,
    })).resolves.toMatchObject({
      discordUserId: "987654321",
      principalId: userId,
      status: "pending",
    });
  });

  test("becomes terminal only after the durable signup credential expires", async () => {
    configureSql({ registered: false, secretLive: false });

    await expect(projectTourneyDiscordOAuthDesiredState({
      claimedUserId: userId,
      commandId: `discord-oauth:${intentId}:${userId}`,
      env,
      intentId,
      operationKey,
      userId,
    })).rejects.toMatchObject({
      code: "TOURNEY_DISCORD_SIGNUP_CREDENTIAL_EXPIRED",
      nonRetryable: true,
    });
  });

  test.each([
    ["referral", "signup"],
    ["tourney", "signin"],
    ["tourney", "link"],
  ])("keeps a missing %s %s account terminal", async (flow, action) => {
    configureSql({ action, flow, registered: false });

    await expect(projectTourneyDiscordOAuthDesiredState({
      claimedUserId: userId,
      commandId: `discord-oauth:${intentId}:${userId}`,
      env,
      intentId,
      operationKey,
      userId,
    })).resolves.toEqual({
      reason: "tourney_not_linked",
      superseded: true,
    });
  });
});
