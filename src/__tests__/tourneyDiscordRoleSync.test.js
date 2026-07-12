const assignment = (overrides = {}) => ({
  queued: true,
  user_id: "e71a5687-daa6-4371-9700-5aef798fdd03",
  discord_user_id: "123456789012345678",
  previous_discord_user_id: null,
  desired_role: "participant",
  applied_role: "none",
  generation: 1,
  ...overrides,
});

const env = {
  DISCORD_BOT_TOKEN: "test-bot-token",
  DISCORD_GUILD_ID: "111111111111111111",
  DISCORD_PARTICIPANT_ROLE_ID: "222222222222222222",
  DISCORD_HOST_ROLE_ID: "333333333333333333",
};

const makeAdminClient = ({ assignments, completeResults = [] }) => {
  const queue = [...assignments];
  const completions = [...completeResults];
  return {
    rpc: jest.fn(async (name) => {
      if (name === "roo_refresh_discord_role_assignment") {
        return { data: queue.shift(), error: null };
      }
      if (name === "roo_complete_discord_role_assignment") {
        return completions.shift() || { data: { status: "applied" }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    }),
  };
};

const makeFetch = (statuses = []) => {
  const queuedStatuses = [...statuses];
  return jest.fn(async () => ({
    ok: true,
    status: queuedStatuses.shift() || 204,
  }));
};

const { syncTourneyDiscordRoleAssignment } = require("../server/tourney/discordRoleSync");

describe("Tourney Discord desired-role synchronization", () => {
  test("adds the Host role before removing Participant", async () => {
    const adminClient = makeAdminClient({
      assignments: [assignment({ desired_role: "host" })],
    });
    const fetchImpl = makeFetch();

    const result = await syncTourneyDiscordRoleAssignment({
      adminClient,
      env,
      fetchImpl,
      userId: assignment().user_id,
    });

    expect(result).toMatchObject({ applied: true, desiredRole: "host" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain("/roles/333333333333333333");
    expect(fetchImpl.mock.calls[0][1].method).toBe("PUT");
    expect(fetchImpl.mock.calls[1][0]).toContain("/roles/222222222222222222");
    expect(fetchImpl.mock.calls[1][1].method).toBe("DELETE");
  });

  test("removes managed roles from the previously linked Discord identity", async () => {
    const previousId = "987654321098765432";
    const adminClient = makeAdminClient({
      assignments: [assignment({ previous_discord_user_id: previousId })],
    });
    const fetchImpl = makeFetch();

    await syncTourneyDiscordRoleAssignment({
      adminClient,
      env,
      fetchImpl,
      userId: assignment().user_id,
    });

    const calls = fetchImpl.mock.calls.map(([url, options]) => ({
      method: options.method,
      url,
    }));
    expect(calls[0]).toMatchObject({ method: "PUT" });
    expect(calls[0].url).toContain("/roles/222222222222222222");
    expect(calls.filter(({ url }) => url.includes(previousId))).toHaveLength(2);
    expect(calls.filter(({ url }) => url.includes(previousId))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "DELETE", url: expect.stringContaining("/roles/222222222222222222") }),
        expect.objectContaining({ method: "DELETE", url: expect.stringContaining("/roles/333333333333333333") }),
      ])
    );
  });

  test("re-reads desired state when a generation changes mid-flight", async () => {
    const adminClient = makeAdminClient({
      assignments: [
        assignment({ desired_role: "participant", generation: 1 }),
        assignment({ desired_role: "host", generation: 2 }),
      ],
      completeResults: [
        { data: null, error: { code: "40001" } },
        { data: { status: "applied" }, error: null },
      ],
    });
    const fetchImpl = makeFetch();

    const result = await syncTourneyDiscordRoleAssignment({
      adminClient,
      env,
      fetchImpl,
      userId: assignment().user_id,
    });

    expect(result).toMatchObject({
      applied: true,
      desiredRole: "host",
      generation: 2,
    });
    expect(
      adminClient.rpc.mock.calls.filter(
        ([name]) => name === "roo_refresh_discord_role_assignment"
      )
    ).toHaveLength(2);
  });

  test("records a retry without exposing Discord response bodies", async () => {
    const adminClient = makeAdminClient({ assignments: [assignment()] });
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 403 }));

    const result = await syncTourneyDiscordRoleAssignment({
      adminClient,
      env,
      fetchImpl,
      userId: assignment().user_id,
    });

    expect(result).toMatchObject({ applied: false, reason: "discord_http_403" });
    expect(adminClient.rpc).toHaveBeenCalledWith(
      "roo_complete_discord_role_assignment",
      expect.objectContaining({
        p_error: "discord_http_403",
        p_status: "retry",
      })
    );
  });
});
