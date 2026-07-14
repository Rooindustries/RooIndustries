const mockSendTourneyResetEmail = jest.fn();
const mockRunTourneyTransaction = jest.fn();

jest.mock("../server/tourney/email.js", () => ({
  sendTourneyAppealAdminEmail: jest.fn(),
  sendTourneyAppealConfirmationEmail: jest.fn(),
  sendTourneyDiscordInviteEmail: jest.fn(),
  sendTourneyPayoutNotificationEmail: jest.fn(),
  sendTourneyPlayerApprovedEmail: jest.fn(),
  sendTourneyRegistrationApprovalEmails: jest.fn(),
  sendTourneyResetEmail: (...args) => mockSendTourneyResetEmail(...args),
}));

jest.mock("../server/tourney/sqlClient.js", () => ({
  getTourneySql: jest.fn(),
  runTourneyTransaction: (...args) => mockRunTourneyTransaction(...args),
}));

jest.mock("../server/tourney/store.js", () => ({
  resolveTourneyStorePolicy: jest.fn(() => ({
    primaryBackend: "legacy",
    mirrorEnabled: false,
    generation: 0,
  })),
}));

const {
  isExpiredTourneyResetDispatch,
  reconcileTourneyEmailDispatches,
} = require("../server/tourney/emailDispatch.js");

const expiredDispatch = {
  id: "dispatch-1",
  idempotency_key: "reset-dispatch-1",
  command_id: "forgot-command-00000001",
  dispatch_kind: "reset",
  recipient: "player@example.com",
  payload: {
    token: "expired-token",
    expiresAt: "2000-01-01T00:00:00.000Z",
  },
  status: "pending",
  attempt_count: 0,
};

const createSql = () => {
  const calls = [];
  const sql = (strings, ...values) => {
    if (typeof strings === "string") return strings;
    const query = strings.join(" ");
    calls.push({ query, values });
    if (query.includes("select * from")) return Promise.resolve([expiredDispatch]);
    return Promise.resolve([]);
  };
  sql.calls = calls;
  return sql;
};

describe("Tourney email dispatch expiry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const sql = createSql();
    mockRunTourneyTransaction.mockImplementation(({ callback }) => callback(sql));
  });

  test("treats missing and elapsed reset expiries as expired", () => {
    expect(isExpiredTourneyResetDispatch({
      dispatch_kind: "reset",
      payload: {},
    })).toBe(true);
    expect(isExpiredTourneyResetDispatch(expiredDispatch, Date.parse(
      "2026-07-14T00:00:00.001Z"
    ))).toBe(true);
  });

  test("dead-letters expired resets without calling the email provider", async () => {
    const result = await reconcileTourneyEmailDispatches({
      env: { NODE_ENV: "production", TOURNEY_DATABASE_MODE: "legacy" },
      limit: 1,
    });

    expect(mockSendTourneyResetEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 1, sent: 0, retried: 0, expired: 1 });
  });
});
