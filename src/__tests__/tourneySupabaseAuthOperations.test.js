const mockRunSupabaseTourneyTransaction = jest.fn();

jest.mock("../server/tourney/sqlClient.js", () => ({
  runSupabaseTourneyTransaction: (...args) =>
    mockRunSupabaseTourneyTransaction(...args),
}));

const {
  claimSupabaseRegistrationDecision,
  isSupabaseDecisionStateApplied,
  isSupabasePasswordStateApplied,
} = require("../server/tourney/supabaseAuthOperations.js");

const completedApproval = {
  id: "operation-1",
  operation_key: "decision:player-1",
  player_id: "player-1",
  token_id: "token-1",
  operation_kind: "decision",
  desired_status: "approved",
  desired_credential_version: "2",
  password_hash: "",
  operation_payload: { approvedRolePlay: "Support" },
  operation_status: "completed",
  lease_id: null,
  lease_expires_at: null,
};

const createSql = () => {
  const sql = jest.fn((strings) => {
    const query = Array.isArray(strings) ? strings.join(" ") : String(strings);
    if (query.includes("roo-tourney-registration-decisions")) {
      return Promise.resolve([]);
    }
    if (query.includes("from tourney.tourney_player_auth_operations")) {
      return Promise.resolve([completedApproval]);
    }
    throw new Error(`Unexpected SQL in test: ${query}`);
  });
  sql.unsafe = jest.fn();
  return sql;
};

describe("Supabase Tourney registration decision operations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunSupabaseTourneyTransaction.mockImplementation(({ callback }) =>
      callback(createSql())
    );
  });

  test("conflicts when a completed registration receives the opposite decision", async () => {
    await expect(
      claimSupabaseRegistrationDecision({
        playerId: "player-1",
        tokenHash: "deny-token-hash",
        purpose: "deny",
        actorUsername: "yukari",
        resolveDecision: jest.fn(),
      })
    ).rejects.toMatchObject({
      code: "TOURNEY_DECISION_CHANGED",
      status: 409,
    });
  });

  test("does not mistake a newer unrelated player version for an applied approval", () => {
    const operation = {
      desired_status: "approved",
      desired_credential_version: "2",
      operation_payload: {
        approvedRolePlay: "Support",
        registrationPool: "main",
      },
    };
    expect(isSupabaseDecisionStateApplied({
      operation,
      player: {
        status: "removed",
        version: 4,
        approved_role_play: "Support",
        registration_pool: "main",
      },
    })).toBe(false);
    expect(isSupabaseDecisionStateApplied({
      operation,
      player: {
        status: "approved",
        version: 4,
        approved_role_play: "Damage",
        registration_pool: "main",
      },
    })).toBe(false);
    expect(isSupabaseDecisionStateApplied({
      operation,
      player: {
        status: "approved",
        version: 4,
        approved_role_play: "Support",
        registration_pool: "main",
      },
    })).toBe(true);
  });

  test("reads legacy stringified JSONB decision payloads during replay", () => {
    expect(isSupabaseDecisionStateApplied({
      operation: {
        desired_status: "approved",
        desired_credential_version: "2",
        operation_payload: JSON.stringify({
          approvedRolePlay: "Tank",
          registrationPool: "substitute",
        }),
      },
      player: {
        status: "approved",
        version: 2,
        approved_role_play: "Tank",
        registration_pool: "substitute",
      },
    })).toBe(true);
  });

  test("requires the exact requested password hash before resuming reset sync", () => {
    const operation = {
      desired_credential_version: "5",
      password_hash: "$2b$12$requested",
    };
    expect(isSupabasePasswordStateApplied({
      operation,
      player: {
        status: "approved",
        version: 8,
        password_hash: "$2b$12$different",
      },
    })).toBe(false);
    expect(isSupabasePasswordStateApplied({
      operation,
      player: {
        status: "approved",
        version: 8,
        password_hash: "$2b$12$requested",
      },
    })).toBe(true);
  });
});
