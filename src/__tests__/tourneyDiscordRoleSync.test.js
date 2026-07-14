const assignment = (overrides = {}) => ({
  discordUserId: "123456789012345678",
  previousDiscordUserId: "",
  desiredRole: "participant",
  generation: 1,
  ...overrides,
});

const env = {
  DISCORD_BOT_TOKEN: "test-bot-token",
  DISCORD_GUILD_ID: "111111111111111111",
  DISCORD_PARTICIPANT_ROLE_ID: "222222222222222222",
  DISCORD_HOST_ROLE_ID: "333333333333333333",
};

const makeFetch = (responses = []) => {
  const queue = [...responses];
  return jest.fn(async () => {
    const next = queue.shift() || { status: 204 };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: {
        get: (name) => next.headers?.[String(name).toLowerCase()] || null,
      },
      json: async () => next.body || {},
    };
  });
};

const {
  applyTourneyDiscordDesiredState,
} = require("../server/tourney/discordRoleSync");

describe("Tourney Discord durable desired-role worker", () => {
  test("adds the Host role before removing Participant", async () => {
    const fetchImpl = makeFetch([
      { status: 200, body: { roles: [env.DISCORD_PARTICIPANT_ROLE_ID] } },
    ]);

    const result = await applyTourneyDiscordDesiredState({
      assignment: assignment({ desiredRole: "host" }),
      env,
      fetchImpl,
    });

    expect(result).toMatchObject({ applied: true, desiredRole: "host" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][1].method).toBe("GET");
    expect(fetchImpl.mock.calls[1][0]).toContain("/roles/333333333333333333");
    expect(fetchImpl.mock.calls[1][1].method).toBe("PUT");
    expect(fetchImpl.mock.calls[2][0]).toContain("/roles/222222222222222222");
    expect(fetchImpl.mock.calls[2][1].method).toBe("DELETE");
  });

  test("removes only managed roles from the previously linked identity", async () => {
    const previousId = "987654321098765432";
    const fetchImpl = makeFetch([
      { status: 200, body: { roles: [env.DISCORD_PARTICIPANT_ROLE_ID] } },
      {
        status: 200,
        body: { roles: [env.DISCORD_PARTICIPANT_ROLE_ID, env.DISCORD_HOST_ROLE_ID] },
      },
    ]);

    await applyTourneyDiscordDesiredState({
      assignment: assignment({ previousDiscordUserId: previousId }),
      env,
      fetchImpl,
    });

    const calls = fetchImpl.mock.calls.map(([url, options]) => ({
      method: options.method,
      url,
    }));
    expect(calls.filter(({ url }) => url.includes(previousId))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "DELETE", url: expect.stringContaining("/roles/222222222222222222") }),
        expect.objectContaining({ method: "DELETE", url: expect.stringContaining("/roles/333333333333333333") }),
      ])
    );
  });

  test("removes managed roles from every identity preserved across rapid relinks", async () => {
    const staleIds = ["777777777777777777", "888888888888888888"];
    const fetchImpl = makeFetch([
      { status: 200, body: { roles: [env.DISCORD_PARTICIPANT_ROLE_ID] } },
      { status: 200, body: { roles: [env.DISCORD_PARTICIPANT_ROLE_ID] } },
      { status: 204 },
      { status: 200, body: { roles: [env.DISCORD_HOST_ROLE_ID] } },
      { status: 204 },
    ]);

    await applyTourneyDiscordDesiredState({
      assignment: assignment({ staleDiscordUserIds: staleIds }),
      env,
      fetchImpl,
    });

    for (const staleId of staleIds) {
      expect(fetchImpl.mock.calls.some(([url, options]) =>
        url.includes(staleId) && options.method === "DELETE"
      )).toBe(true);
    }
  });

  test("joins with the ephemeral OAuth token only after confirming membership is absent", async () => {
    const fetchImpl = makeFetch([
      { status: 404 },
      { status: 201 },
      { status: 200, body: { roles: [] } },
      { status: 204 },
    ]);

    await applyTourneyDiscordDesiredState({
      accessToken: "ephemeral-oauth-token",
      assignment: assignment(),
      env,
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0][1].method).toBe("GET");
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ access_token: "ephemeral-oauth-token" }),
    });
  });

  test("does not attempt a guild join when an OAuth user is already a member", async () => {
    const fetchImpl = makeFetch([
      { status: 200, body: { roles: [env.DISCORD_PARTICIPANT_ROLE_ID] } },
    ]);

    await expect(applyTourneyDiscordDesiredState({
      accessToken: "ephemeral-oauth-token",
      assignment: assignment(),
      env,
      fetchImpl,
    })).resolves.toMatchObject({ applied: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].method).toBe("GET");
  });

  test("classifies a missing guilds.join grant as blocked reauth", async () => {
    const fetchImpl = makeFetch([{ status: 404 }, { status: 403 }]);

    await expect(applyTourneyDiscordDesiredState({
      accessToken: "oauth-token-without-guild-scope",
      assignment: assignment(),
      env,
      fetchImpl,
    })).resolves.toEqual({ applied: false, reason: "blocked_reauth" });
  });

  test("marks an already-correct assignment applied without role mutations", async () => {
    const fetchImpl = makeFetch([
      { status: 200, body: { roles: [env.DISCORD_PARTICIPANT_ROLE_ID, "unmanaged"] } },
    ]);

    await expect(applyTourneyDiscordDesiredState({
      assignment: assignment(),
      env,
      fetchImpl,
    })).resolves.toMatchObject({ applied: true, desiredRole: "participant" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].method).toBe("GET");
  });

  test("classifies a user absent from the guild as blocked reauth", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 404 }));

    await expect(applyTourneyDiscordDesiredState({
      assignment: assignment(),
      env,
      fetchImpl,
    })).resolves.toEqual({ applied: false, reason: "blocked_reauth" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("treats an absent member as a completed role removal", async () => {
    const fetchImpl = makeFetch([{ status: 404 }]);

    await expect(applyTourneyDiscordDesiredState({
      accessToken: "must-not-rejoin-for-removal",
      assignment: assignment({ desiredRole: "none" }),
      env,
      fetchImpl,
    })).resolves.toEqual({ applied: true, desiredRole: "none" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].method).toBe("GET");
  });

  test("returns only a safe status code for provider failure", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 403 }));

    await expect(applyTourneyDiscordDesiredState({
      assignment: assignment(),
      env,
      fetchImpl,
    })).rejects.toMatchObject({ code: "discord_http_403" });
  });

  test("preserves Discord global retry timing for durable scheduling", async () => {
    const fetchImpl = makeFetch([{
      status: 429,
      body: { retry_after: 2.5, global: true },
      headers: { "retry-after": "1" },
    }]);

    await expect(applyTourneyDiscordDesiredState({
      assignment: assignment(),
      env,
      fetchImpl,
    })).rejects.toMatchObject({
      code: "discord_global_rate_limited",
      retryAfterMs: 2500,
      discordGlobalRateLimit: true,
    });
  });

  test("fences every Discord role mutation", async () => {
    const fetchImpl = makeFetch([
      { status: 200, body: { roles: [env.DISCORD_PARTICIPANT_ROLE_ID] } },
      { status: 204 },
      { status: 204 },
    ]);
    const withMutationFence = jest.fn(async (callback) => callback());

    await applyTourneyDiscordDesiredState({
      assignment: assignment({ desiredRole: "host" }),
      env,
      fetchImpl,
      withMutationFence,
    });

    expect(withMutationFence).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.slice(1).map(([, options]) => options.method)).toEqual([
      "PUT",
      "DELETE",
    ]);
  });

  test("turns a bounded Discord timeout into a safe retry error", async () => {
    const fetchImpl = jest.fn((_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })
    );

    await expect(applyTourneyDiscordDesiredState({
      assignment: assignment(),
      deadlineAt: Date.now() + 20,
      env,
      fetchImpl,
    })).rejects.toMatchObject({ code: "discord_request_timeout" });
  });
});
