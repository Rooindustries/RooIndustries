const mockGetUserById = jest.fn();
const mockCompleteProjection = jest.fn();

jest.mock("../server/supabase/adminClient", () => ({
  createSupabaseAdminClient: () => ({
    auth: { admin: { getUserById: (...args) => mockGetUserById(...args) } },
  }),
  resolveSupabaseAdminEnv: () => ({
    secretKey: "service-role-test-key",
    url: "https://supabase.invalid",
  }),
}));

jest.mock("../server/tourney/discordDesiredState", () => ({
  completeTourneyIdentityUnlinkProjection: (...args) => mockCompleteProjection(...args),
}));

const {
  executeSupabaseIdentityUnlinkOperation,
} = require("../server/tourney/externalOperations");

const operation = {
  command_id: "identity-unlink:discord:user-1:grant-1",
  operation_key: "operation-1",
};
const state = {
  identityId: "discord-identity-1",
  provider: "discord",
  userId: "11111111-1111-4111-8111-111111111111",
};

describe("durable Supabase identity unlink recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCompleteProjection.mockResolvedValue({ queued: true });
  });

  test("reconciles an already-absent identity without requiring the expired secret", async () => {
    mockGetUserById.mockResolvedValue({
      data: { user: { identities: [] } },
      error: null,
    });
    const readSecret = jest.fn().mockRejectedValue(new Error("expired"));
    const fetchImpl = jest.fn();

    await expect(executeSupabaseIdentityUnlinkOperation({
      operation,
      state,
      env: {},
      fetchImpl,
      readSecret,
    })).resolves.toEqual({ applied: true, provider: "discord" });

    expect(readSecret).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockCompleteProjection).toHaveBeenCalledTimes(1);
  });

  test("recovers after provider success and a failed local projection even after secret expiry", async () => {
    mockGetUserById
      .mockResolvedValueOnce({
        data: {
          user: {
            identities: [{
              identity_id: state.identityId,
              provider: state.provider,
            }],
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { user: { identities: [] } }, error: null });
    mockCompleteProjection
      .mockRejectedValueOnce(new Error("projection transaction failed"))
      .mockResolvedValueOnce({ queued: true });
    const readSecret = jest
      .fn()
      .mockResolvedValueOnce({ accessToken: "short-lived-user-token" })
      .mockRejectedValue(new Error("expired"));
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 204 });

    await expect(executeSupabaseIdentityUnlinkOperation({
      operation,
      state,
      env: {},
      fetchImpl,
      readSecret,
    })).rejects.toThrow("projection transaction failed");
    await expect(executeSupabaseIdentityUnlinkOperation({
      operation,
      state,
      env: {},
      fetchImpl,
      readSecret,
    })).resolves.toEqual({ applied: true, provider: "discord" });

    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mockCompleteProjection).toHaveBeenCalledTimes(2);
  });
});
